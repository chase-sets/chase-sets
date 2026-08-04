import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredEvent } from "@chase-sets/event-core";

// The spies wrap the shipped implementations rather than replacing them, so
// every case still exercises the real digest and hash while recording exactly
// which arguments this module handed each helper.
vi.mock("./public-referral-code", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./public-referral-code")>();
  return {
    ...actual,
    publicReferralCodeDigest: vi.fn(actual.publicReferralCodeDigest),
    sha256Hex: vi.fn(actual.sha256Hex),
  };
});

import {
  PUBLIC_REFERRAL_CODE_RESERVATION_STREAM_PREFIX,
  generatePublicReferralCode,
  lowercaseSha256Pattern,
  publicReferralCodeDigest,
  publicReferralCodePattern,
  publicReferralCodeReservationStreamId,
  sha256Hex,
  waitlistSignupIdPattern,
} from "./public-referral-code";
import {
  PUBLIC_PRESENCE_RECONCILIATION_CLASS,
  RECONCILIATION_REFUSAL_CATEGORIES,
  RECONCILIATION_REFUSAL_COUNTER_COVERAGE,
  RESERVATION_RECONCILIATION_EVENT_TYPES,
  SIGNUP_CLASS_MATCHES_WAITLIST_SIGNUP_EVENTS,
  SIGNUP_RECONCILIATION_EVENT_TYPES,
  admitReferralCodeIdentityAndVocabulary,
  buildReferralCodeObservationIndex,
  cleanReconciliationRefusalCounts,
  correlateIssuedPublicReferralCode,
  createReconciliationSubjectLedger,
  factSubjectKey,
  issuedDigestSubjectKey,
  observedEventTypeClass,
  provisioningIdentitySubjectKey,
  reconciliationRefusalTotal,
  streamSubjectKey,
  type IssuanceCorrelation,
  type ObservedPayloadValue,
  type ReconciliationRefusalCounts,
  type ReconciliationStreamNamespaces,
} from "./referral-code-reconciliation-algebra";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNUP_STREAM_PREFIX = "public-presence.waitlist-signup-";

const NAMESPACES: ReconciliationStreamNamespaces = {
  reservationStreamPrefix: PUBLIC_REFERRAL_CODE_RESERVATION_STREAM_PREFIX,
  signupStreamPrefix: SIGNUP_STREAM_PREFIX,
};

const RECORDED_TYPE = "public-presence.waitlist-signup.recorded";
const ISSUED_TYPE = "public-presence.waitlist-referral-code.issued";
const RESERVED_TYPE = "public-presence.waitlist-referral-code.reserved";
const PROVISIONED_TYPE = "public-presence.waitlist-referral-link.provisioned";
const UNREGISTERED_TYPE = "public-presence.waitlist-signup.synthesized-by-nobody";

const VALID_CODE = generatePublicReferralCode((length) => new Uint8Array(length).fill(7));
const SECOND_VALID_CODE = generatePublicReferralCode((length) => new Uint8Array(length).fill(11));
const CANONICAL_RESERVATION_STREAM = publicReferralCodeReservationStreamId(VALID_CODE);
const CANONICAL_SUFFIX = CANONICAL_RESERVATION_STREAM.slice(PUBLIC_REFERRAL_CODE_RESERVATION_STREAM_PREFIX.length);
const VALID_SIGNUP_SUFFIX = "wls_abc123";
const VALID_SIGNUP_STREAM = SIGNUP_STREAM_PREFIX + VALID_SIGNUP_SUFFIX;
const MALFORMED_SIGNUP_SUFFIX = "wls_UPPER";
const MALFORMED_SIGNUP_STREAM = SIGNUP_STREAM_PREFIX + MALFORMED_SIGNUP_SUFFIX;
const MALFORMED_RESERVATION_STREAM = PUBLIC_REFERRAL_CODE_RESERVATION_STREAM_PREFIX + "not-hex";
const OUT_OF_SCOPE_STREAM = "public-presence.poison-reservation-1";

const MALFORMED_CODE = "wlr_short";

const CLEAN_COUNTS: ReconciliationRefusalCounts = {
  unexpected: 0,
  mismatched: 0,
  duplicate: 0,
  missingRecorded: 0,
  missingIssued: 0,
  missingReservation: 0,
};

/** Independent SHA-256, computed straight from node:crypto rather than through the module under test. */
function expectedSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

let nextEventOrdinal = 0;

function storedEvent(
  streamId: string,
  streamVersion: number,
  eventType: string,
  payload: StoredEvent["payload"] = {},
): StoredEvent {
  nextEventOrdinal += 1;
  return {
    eventId: `evt_algebra_${nextEventOrdinal}` as never,
    streamId,
    streamVersion,
    globalPosition: `${nextEventOrdinal}` as never,
    tenantId: "tnt_test" as never,
    eventType,
    payload,
    metadata: {},
    occurredAt: "2026-08-04T00:00:00.000Z" as never,
    recordedAt: "2026-08-04T00:00:00.000Z" as never,
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  };
}

function issuedFact(streamId: string, streamVersion: number, publicReferralCode: ObservedPayloadValue): StoredEvent {
  return storedEvent(streamId, streamVersion, ISSUED_TYPE, { signupId: "wls_abc123", publicReferralCode });
}

const digestSpy = vi.mocked(publicReferralCodeDigest);
const hashSpy = vi.mocked(sha256Hex);

// Resolved from this test file's own path rather than through a URL instance:
// the jsdom environment replaces the global URL class, and node:url refuses the
// result of resolving against it.
const MODULE_SOURCE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "referral-code-reconciliation-algebra.ts"),
  "utf8",
);

/**
 * The module source with comments and import declarations removed. Every slash
 * this module is allowed to contain lives in a comment or an import specifier,
 * so a regular-expression literal anywhere else survives this strip.
 */
const MODULE_CODE_ONLY = MODULE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/.*$/gm, " ")
  .replace(/\bimport\b[^;]*;/g, " ");

function attemptMutation(mutate: () => void): void {
  try {
    mutate();
  } catch {
    // Frozen structures reject the write in strict mode; the assertion below
    // proves the structure is unchanged either way.
  }
}

function structuralSnapshot(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Criterion 1 -- the frozen, ordered, derived refusal taxonomy
// ---------------------------------------------------------------------------

describe("reconciliation refusal taxonomy", () => {
  it("names the six refusal categories literally and in their published order", () => {
    expect(RECONCILIATION_REFUSAL_CATEGORIES).toEqual([
      "unexpected",
      "mismatched",
      "duplicate",
      "missingRecorded",
      "missingIssued",
      "missingReservation",
    ]);
    expect(RECONCILIATION_REFUSAL_CATEGORIES).toHaveLength(6);
    expect(RECONCILIATION_REFUSAL_COUNTER_COVERAGE).toBe(true);
  });

  it("starts a clean count object at zero for every category with a zero total", () => {
    const counts = cleanReconciliationRefusalCounts();
    expect(counts).toEqual(CLEAN_COUNTS);
    expect(Object.keys(counts).sort()).toEqual([...RECONCILIATION_REFUSAL_CATEGORIES].sort());
    expect(reconciliationRefusalTotal(counts)).toBe(0);
  });

  it("sums refusalTotal as the exact sum of the six counts for a populated object", () => {
    const populated: ReconciliationRefusalCounts = {
      unexpected: 3,
      mismatched: 1,
      duplicate: 4,
      missingRecorded: 1,
      missingIssued: 5,
      missingReservation: 9,
    };
    expect(reconciliationRefusalTotal(populated)).toBe(3 + 1 + 4 + 1 + 5 + 9);
    expect(reconciliationRefusalTotal(populated)).toBe(23);
  });

  it("builds the count object from the exported tuple rather than a hand-written literal", () => {
    expect(MODULE_CODE_ONLY).toContain("for (const category of RECONCILIATION_REFUSAL_CATEGORIES)");
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 -- typed subject keys over exactly four kinds
// ---------------------------------------------------------------------------

describe("reconciliation subject keys", () => {
  it("keeps a stream key and a fact key distinct where a joined string would collide", () => {
    const ledger = createReconciliationSubjectLedger();
    // Soft so a joined-string key mutant reports the count it collapsed to as
    // well as the write it swallowed, rather than stopping at the first.
    expect.soft(ledger.record(streamSubjectKey("s-1"), "N1", "unexpected"), "stream s-1 counted").toBe(true);
    expect.soft(ledger.record(factSubjectKey("s", 1), "F1", "unexpected"), "fact s/1 counted").toBe(true);

    const result = ledger.result();
    expect.soft(result.counts, "six-count object").toEqual({ ...CLEAN_COUNTS, unexpected: 2 });
    expect.soft(result.refusalTotal, "refusalTotal").toBe(2);
    expect
      .soft(
        result.records.map((entry) => entry.key.kind),
        "recorded kinds",
      )
      .toEqual(["stream", "fact"]);
    expect.soft(result.suppressedWrites, "suppressedWrites").toEqual([]);
  });

  it("treats a fact key as equal only to a fact key with the same stream id and stream version", () => {
    const ledger = createReconciliationSubjectLedger();
    expect(ledger.record(factSubjectKey("s", 1), "F1", "unexpected")).toBe(true);
    expect(ledger.record(factSubjectKey("s", 2), "F1", "duplicate")).toBe(true);
    expect(ledger.record(factSubjectKey("other", 1), "F2", "mismatched")).toBe(true);
    expect(ledger.record(factSubjectKey("s", 1), "F2", "missingIssued")).toBe(false);

    const result = ledger.result();
    expect(result.counts).toEqual({ ...CLEAN_COUNTS, unexpected: 1, duplicate: 1, mismatched: 1 });
    expect(result.suppressedWrites).toHaveLength(1);
    expect(result.suppressedWrites[0]?.key).toEqual({ kind: "fact", streamId: "s", streamVersion: 1 });
  });

  it("holds all four subject kinds without any two of them sharing a slot", () => {
    const ledger = createReconciliationSubjectLedger();
    expect(ledger.record(streamSubjectKey("x"), "N1", "unexpected")).toBe(true);
    expect(ledger.record(factSubjectKey("x", 0), "F1", "unexpected")).toBe(true);
    expect(ledger.record(issuedDigestSubjectKey("x"), "X1", "duplicate")).toBe(true);
    expect(ledger.record(provisioningIdentitySubjectKey("x"), "G1", "mismatched")).toBe(true);

    const result = ledger.result();
    expect(result.records.map((entry) => entry.key.kind)).toEqual([
      "stream",
      "fact",
      "issued-digest",
      "provisioning-identity",
    ]);
    expect(result.refusalTotal).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 -- first write wins, every later write reported
// ---------------------------------------------------------------------------

describe("reconciliation subject ledger", () => {
  it("keeps the first row, the first category and the six counts unchanged on a second write to one key", () => {
    const ledger = createReconciliationSubjectLedger();
    const key = streamSubjectKey("public-presence.waitlist-signup-wls_a");
    expect(ledger.record(key, "H3", "missingRecorded")).toBe(true);
    const afterFirst = ledger.result();

    expect(ledger.record(key, "H4", "missingIssued")).toBe(false);
    const afterSecond = ledger.result();

    expect(afterSecond.counts).toEqual(afterFirst.counts);
    expect(afterSecond.counts).toEqual({ ...CLEAN_COUNTS, missingRecorded: 1 });
    expect(ledger.recordedFor(key)?.row).toBe("H3");
    expect(ledger.recordedFor(key)?.category).toBe("missingRecorded");
    expect(afterSecond.suppressedWrites).toHaveLength(1);
    expect(afterSecond.suppressedWrites[0]).toEqual({ key, row: "H4", category: "missingIssued" });
  });

  it("appends a second suppressed entry on a third write to the same key", () => {
    const ledger = createReconciliationSubjectLedger();
    const key = factSubjectKey("s", 7);
    ledger.record(key, "F4", "unexpected");
    ledger.record(key, "F5", "mismatched");
    ledger.record(key, "F3", "duplicate");

    const result = ledger.result();
    expect(result.counts).toEqual({ ...CLEAN_COUNTS, unexpected: 1 });
    expect(result.refusalTotal).toBe(1);
    expect(result.suppressedWrites.map((entry) => [entry.row, entry.category])).toEqual([
      ["F5", "mismatched"],
      ["F3", "duplicate"],
    ]);
  });

  it("counts two writes on two distinct keys of the same kind", () => {
    const ledger = createReconciliationSubjectLedger();
    expect(ledger.record(streamSubjectKey("a"), "N1", "unexpected")).toBe(true);
    expect(ledger.record(streamSubjectKey("b"), "N2", "unexpected")).toBe(true);
    expect(ledger.result().counts).toEqual({ ...CLEAN_COUNTS, unexpected: 2 });
    expect(ledger.result().suppressedWrites).toEqual([]);
  });

  it("counts two writes on two keys of different kinds", () => {
    const ledger = createReconciliationSubjectLedger();
    expect(ledger.record(streamSubjectKey("a"), "N1", "unexpected")).toBe(true);
    expect(ledger.record(issuedDigestSubjectKey("a"), "X1", "duplicate")).toBe(true);
    expect(ledger.result().counts).toEqual({ ...CLEAN_COUNTS, unexpected: 1, duplicate: 1 });
    expect(ledger.result().suppressedWrites).toEqual([]);
  });

  it("returns a frozen result whose inventories a consumer cannot narrow", () => {
    const ledger = createReconciliationSubjectLedger();
    ledger.record(streamSubjectKey("a"), "N1", "unexpected");
    const result = ledger.result();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.counts)).toBe(true);
    expect(Object.isFrozen(result.records)).toBe(true);
    expect(Object.isFrozen(result.suppressedWrites)).toBe(true);
    expect(Object.isFrozen(result.records[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Criteria 4 and 5 -- issuance correlation over the whole JSON value space
// ---------------------------------------------------------------------------

describe("issuance correlation", () => {
  it("correlates all nine observed value shapes from the value alone", () => {
    const table: readonly (readonly [string, ObservedPayloadValue, IssuanceCorrelation])[] = [
      ["valid wlr_ code", VALID_CODE, { kind: "canonical", digest: expectedSha256(VALID_CODE) }],
      ["malformed string wlr_short", MALFORMED_CODE, { kind: "opaque", fingerprint: expectedSha256(MALFORMED_CODE) }],
      ["empty string", "", { kind: "opaque", fingerprint: expectedSha256("") }],
      ["JSON number 42", 42, { kind: "uncorrelatable" }],
      ["JSON true", true, { kind: "uncorrelatable" }],
      ["JSON null", null, { kind: "uncorrelatable" }],
      ["JSON empty array", [], { kind: "uncorrelatable" }],
      ["JSON empty object", {}, { kind: "uncorrelatable" }],
      ["absent member", undefined, { kind: "uncorrelatable" }],
    ];
    expect(table).toHaveLength(9);

    const observed = table.map(([label, value]) => [label, correlateIssuedPublicReferralCode(value)] as const);
    console.log("correlation table", JSON.stringify(observed, null, 2));

    for (const [label, value, expected] of table) {
      expect(correlateIssuedPublicReferralCode(value), label).toEqual(expected);
    }
  });

  it("hands the throwing canonical helper only the value that already matched the imported pattern", () => {
    const values: readonly ObservedPayloadValue[] = [VALID_CODE, MALFORMED_CODE, "", 42, true, null, [], {}, undefined];
    for (const value of values) {
      correlateIssuedPublicReferralCode(value);
    }

    expect(digestSpy.mock.calls).toEqual([[VALID_CODE]]);
    expect(hashSpy.mock.calls).toEqual([[MALFORMED_CODE], [""]]);
  });

  it("leaves every non-string observed value uncorrelatable", () => {
    const nonStrings: readonly ObservedPayloadValue[] = [42, true, null, [], {}, undefined];
    expect(nonStrings).toHaveLength(6);
    for (const value of nonStrings) {
      expect(correlateIssuedPublicReferralCode(value), JSON.stringify(value) ?? "absent member").toEqual({
        kind: "uncorrelatable",
      });
    }
    expect(digestSpy).toHaveBeenCalledTimes(0);
    expect(hashSpy).toHaveBeenCalledTimes(0);
  });

  it("fingerprints the malformed string wlr_short opaquely and never canonically", () => {
    const correlation = correlateIssuedPublicReferralCode(MALFORMED_CODE);

    // Soft so a pattern-loosening mutant reports all three named assertions --
    // the kind, the member name and the spy -- rather than stopping at the first.
    expect.soft(correlation.kind, "kind").toBe("opaque");
    expect.soft(correlation, "member name").toHaveProperty("fingerprint", expectedSha256(MALFORMED_CODE));
    expect.soft(correlation, "member name").not.toHaveProperty("digest");
    expect.soft(digestSpy, "canonical digest spy").toHaveBeenCalledTimes(0);

    const index = buildReferralCodeObservationIndex([issuedFact(VALID_SIGNUP_STREAM, 0, MALFORMED_CODE)], NAMESPACES);
    expect.soft(index.observedIssuanceSuffixes, "union").toEqual([expectedSha256(MALFORMED_CODE)]);
    expect.soft(index.observedIssuanceSuffixes, "union").not.toContain(expectedSha256(VALID_CODE));
    expect.soft(digestSpy, "canonical digest spy").toHaveBeenCalledTimes(0);
  });

  it("declares no coercion of the observed code value anywhere in the module", () => {
    expect(MODULE_SOURCE).not.toContain("String(");
    expect(MODULE_SOURCE).not.toContain("`");
    expect(MODULE_SOURCE).not.toMatch(/\+\s*""/);
    expect(MODULE_SOURCE).not.toContain(".toString(");
    expect(MODULE_SOURCE).not.toContain("JSON.stringify");
  });

  it("declares no regular-expression literal of its own and imports the shipped patterns instead", () => {
    expect(MODULE_CODE_ONLY).not.toContain("/");
    expect(MODULE_CODE_ONLY).not.toContain("RegExp");
    expect(MODULE_SOURCE).toContain("publicReferralCodePattern");
    expect(MODULE_SOURCE).toContain("waitlistSignupIdPattern");
    expect(MODULE_SOURCE).toContain("lowercaseSha256Pattern");
  });

  it("reuses the shipped syntax authority byte for byte", () => {
    expect(publicReferralCodePattern.source).toBe("^wlr_[A-Za-z0-9_-]{32,}$");
    expect(waitlistSignupIdPattern.source).toBe("^wls_[0-9a-z]+$");
    expect(lowercaseSha256Pattern.source).toBe("^[0-9a-f]{64}$");
  });
});

// ---------------------------------------------------------------------------
// Criteria 6 and 7 -- the observation index and the observed issuance union
// ---------------------------------------------------------------------------

function spanningFacts(): readonly StoredEvent[] {
  return [
    storedEvent(CANONICAL_RESERVATION_STREAM, 0, RESERVED_TYPE, {
      codeDigest: CANONICAL_SUFFIX,
      reservedAt: "2026-08-04T00:00:00.000Z",
    }),
    storedEvent(VALID_SIGNUP_STREAM, 0, RECORDED_TYPE, { signupId: VALID_SIGNUP_SUFFIX }),
    issuedFact(VALID_SIGNUP_STREAM, 1, VALID_CODE),
    issuedFact(MALFORMED_SIGNUP_STREAM, 0, MALFORMED_CODE),
  ];
}

describe("observation index", () => {
  it("indexes every in-scope fact on every in-scope stream, including streams a later row refuses", () => {
    const index = buildReferralCodeObservationIndex(spanningFacts(), NAMESPACES);
    console.log("observation index", JSON.stringify(structuralSnapshot(index), null, 2));

    expect(index.streams.map((stream) => [stream.streamId, stream.facts.length])).toEqual([
      [CANONICAL_RESERVATION_STREAM, 1],
      [VALID_SIGNUP_STREAM, 2],
      [MALFORMED_SIGNUP_STREAM, 1],
    ]);
    expect(index.streams.map((stream) => stream.kind)).toEqual(["reservation", "signup", "signup"]);
    expect(index.reservationStreamIds).toEqual([CANONICAL_RESERVATION_STREAM]);
    expect(index.outOfScopeFactCount).toBe(0);

    const signupStream = index.streams[1];
    expect(signupStream?.factsByEventType.map((group) => [group.eventType, group.facts.length])).toEqual([
      [RECORDED_TYPE, 1],
      [ISSUED_TYPE, 1],
    ]);
  });

  it("keeps an issuance on a malformed-suffix stream in the correlation inventory with its value-determined kind", () => {
    const index = buildReferralCodeObservationIndex(spanningFacts(), NAMESPACES);
    expect(index.issuances).toEqual([
      {
        streamId: VALID_SIGNUP_STREAM,
        streamVersion: 1,
        correlation: { kind: "canonical", digest: expectedSha256(VALID_CODE) },
      },
      {
        streamId: MALFORMED_SIGNUP_STREAM,
        streamVersion: 0,
        correlation: { kind: "opaque", fingerprint: expectedSha256(MALFORMED_CODE) },
      },
    ]);
  });

  it("returns a deep-frozen index that a mutation attempt leaves structurally equal", () => {
    const index = buildReferralCodeObservationIndex(spanningFacts(), NAMESPACES);
    const before = structuralSnapshot(index);

    const collections: readonly unknown[] = [
      index,
      index.streams,
      index.reservationStreamIds,
      index.issuances,
      index.observedIssuanceSuffixes,
      ...index.streams,
      ...index.streams.map((stream) => stream.facts),
      ...index.streams.flatMap((stream) => stream.facts),
      ...index.streams.map((stream) => stream.factsByEventType),
      ...index.streams.flatMap((stream) => stream.factsByEventType),
      ...index.streams.flatMap((stream) => stream.factsByEventType.map((group) => group.facts)),
      ...index.issuances,
      ...index.issuances.map((issuance) => issuance.correlation),
    ];
    for (const collection of collections) {
      expect(Object.isFrozen(collection)).toBe(true);
    }

    attemptMutation(() => {
      (index.observedIssuanceSuffixes as string[]).push("forged");
    });
    attemptMutation(() => {
      (index.streams as unknown as unknown[]).length = 0;
    });
    attemptMutation(() => {
      (index as unknown as { outOfScopeFactCount: number }).outOfScopeFactCount = 99;
    });
    expect(structuralSnapshot(index)).toEqual(before);
  });

  it("builds the index from an exported surface that takes no verdict, category or row argument", () => {
    const declarations = [...MODULE_CODE_ONLY.matchAll(/export function (\w+)\(([^)]*)\)/g)];
    expect(declarations.length).toBeGreaterThanOrEqual(13);
    for (const [, name, parameters] of declarations) {
      expect(parameters?.toLowerCase() ?? "", name).not.toMatch(/verdict|category|\brow\b/);
    }

    const index = buildReferralCodeObservationIndex(spanningFacts(), NAMESPACES);
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry);
        return;
      }
      if (value !== null && typeof value === "object") {
        for (const [key, entry] of Object.entries(value)) {
          keys.add(key.toLowerCase());
          walk(entry);
        }
      }
    };
    walk(index);
    for (const key of keys) {
      expect(key).not.toMatch(/verdict|category|\brow\b/);
    }
  });

  it("leaves the caller's fact set and its payloads exactly as they were found", () => {
    const facts = spanningFacts();
    const before = structuralSnapshot(facts);
    const index = buildReferralCodeObservationIndex(facts, NAMESPACES);

    expect(structuralSnapshot(facts)).toEqual(before);
    expect(facts.every((fact) => !Object.isFrozen(fact.payload))).toBe(true);
    expect(index.streams[0]?.facts[0]?.payload).toBe(facts[0]?.payload);
  });

  it("unions exactly the canonical digests and opaque fingerprints of observed issuances", () => {
    const index = buildReferralCodeObservationIndex(
      [
        issuedFact(VALID_SIGNUP_STREAM, 0, VALID_CODE),
        issuedFact(VALID_SIGNUP_STREAM, 1, MALFORMED_CODE),
        issuedFact(VALID_SIGNUP_STREAM, 2, 42),
      ],
      NAMESPACES,
    );
    console.log("observed issuance suffixes", JSON.stringify(index.observedIssuanceSuffixes, null, 2));

    expect(index.observedIssuanceSuffixes).toEqual([expectedSha256(VALID_CODE), expectedSha256(MALFORMED_CODE)]);
    expect(index.observedIssuanceSuffixes).toHaveLength(2);
    expect(index.issuances.map((issuance) => issuance.correlation.kind)).toEqual([
      "canonical",
      "opaque",
      "uncorrelatable",
    ]);
  });

  it("contributes no union member for an uncorrelatable issuance", () => {
    const index = buildReferralCodeObservationIndex([issuedFact(VALID_SIGNUP_STREAM, 0, 42)], NAMESPACES);
    expect(index.issuances).toHaveLength(1);
    expect(index.issuances[0]?.correlation).toEqual({ kind: "uncorrelatable" });
    expect(index.observedIssuanceSuffixes).toEqual([]);
    expect(index.observedIssuanceSuffixes).toHaveLength(0);
  });

  it("deduplicates the union so one repeated issuance value contributes one member", () => {
    const index = buildReferralCodeObservationIndex(
      [issuedFact(VALID_SIGNUP_STREAM, 0, VALID_CODE), issuedFact(VALID_SIGNUP_STREAM, 1, VALID_CODE)],
      NAMESPACES,
    );
    expect(index.observedIssuanceSuffixes).toEqual([expectedSha256(VALID_CODE)]);
    expect(index.issuances).toHaveLength(2);
  });

  it("accounts a fact on a stream matching neither namespace without throwing and without an index entry", () => {
    const facts = [
      storedEvent(OUT_OF_SCOPE_STREAM, 0, RESERVED_TYPE, { codeDigest: CANONICAL_SUFFIX }),
      storedEvent(OUT_OF_SCOPE_STREAM, 1, ISSUED_TYPE, { publicReferralCode: VALID_CODE }),
      storedEvent(VALID_SIGNUP_STREAM, 0, RECORDED_TYPE),
    ];
    const index = buildReferralCodeObservationIndex(facts, NAMESPACES);

    expect(index.outOfScopeFactCount).toBe(2);
    expect(index.streams.map((stream) => stream.streamId)).toEqual([VALID_SIGNUP_STREAM]);
    expect(index.issuances).toEqual([]);
    expect(index.observedIssuanceSuffixes).toEqual([]);
    expect(digestSpy).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// Criterion 10 -- one total classifier over the closed public payload registry
// ---------------------------------------------------------------------------

describe("reconciliation event vocabulary", () => {
  it("derives both runtime sets from the classifier's own keys and holds six and one member today", () => {
    expect(SIGNUP_RECONCILIATION_EVENT_TYPES).toEqual([
      "public-presence.waitlist-signup.recorded",
      "public-presence.waitlist-signup.updated",
      "public-presence.waitlist-signup.cohort-quality-provided",
      "public-presence.waitlist-signup.admitted",
      "public-presence.waitlist-referral-code.issued",
      "public-presence.waitlist-referral-link.provisioned",
    ]);
    expect(SIGNUP_RECONCILIATION_EVENT_TYPES).toHaveLength(6);
    expect(RESERVATION_RECONCILIATION_EVENT_TYPES).toEqual([RESERVED_TYPE]);
    expect(RESERVATION_RECONCILIATION_EVENT_TYPES).toHaveLength(1);
    expect(SIGNUP_CLASS_MATCHES_WAITLIST_SIGNUP_EVENTS).toBe(true);
  });

  it("partitions the seven registry keys with no leftover and no overlap", () => {
    const registryKeys = Object.keys(PUBLIC_PRESENCE_RECONCILIATION_CLASS);
    expect(registryKeys).toHaveLength(7);

    const union = [...SIGNUP_RECONCILIATION_EVENT_TYPES, ...RESERVATION_RECONCILIATION_EVENT_TYPES];
    expect([...union].sort()).toEqual([...registryKeys].sort());
    expect(union).toHaveLength(7);
    expect(
      SIGNUP_RECONCILIATION_EVENT_TYPES.filter((key) => RESERVATION_RECONCILIATION_EVENT_TYPES.includes(key)),
    ).toEqual([]);
  });

  it("agrees between the runtime sets and the total observed-event-type classifier", () => {
    for (const key of Object.keys(PUBLIC_PRESENCE_RECONCILIATION_CLASS)) {
      expect(SIGNUP_RECONCILIATION_EVENT_TYPES.includes(key), key).toBe(observedEventTypeClass(key) === "signup");
      expect(RESERVATION_RECONCILIATION_EVENT_TYPES.includes(key), key).toBe(
        observedEventTypeClass(key) === "reservation",
      );
    }
    expect(observedEventTypeClass(UNREGISTERED_TYPE)).toBe("unregistered");
    expect(observedEventTypeClass("")).toBe("unregistered");
    expect(observedEventTypeClass("toString")).toBe("unregistered");
    expect(observedEventTypeClass("__proto__")).toBe("unregistered");
    expect(observedEventTypeClass("constructor")).toBe("unregistered");
  });

  it("reads only the closed payload registry, the domain union and the shipped syntax module", () => {
    const specifiers = [...MODULE_SOURCE.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(specifiers).toEqual(["@chase-sets/event-core", "./domain", "./public-referral-code"]);
    expect(MODULE_SOURCE).not.toContain("context.json");
    expect(MODULE_CODE_ONLY).not.toContain("Exclude");
  });
});

// ---------------------------------------------------------------------------
// Criteria 11 and 12 -- rows N1, N2, F1 and F2, and phase-one fact suppression
// ---------------------------------------------------------------------------

describe("identity and vocabulary rows", () => {
  it("counts N1 on a reservation-namespace stream whose suffix is not a lowercase 64-hex digest", () => {
    const result = admitReferralCodeIdentityAndVocabulary(
      [storedEvent(MALFORMED_RESERVATION_STREAM, 0, RESERVED_TYPE, { codeDigest: "not-hex" })],
      NAMESPACES,
    );
    console.log("N1 ledger", JSON.stringify(structuralSnapshot(result.ledger), null, 2));

    expect(result.counts).toEqual({ ...CLEAN_COUNTS, unexpected: 1 });
    expect(result.refusalTotal).toBe(1);
    expect(result.ledger.records).toHaveLength(1);
    expect(result.ledger.records[0]?.row).toBe("N1");
    expect(result.ledger.records[0]?.key).toEqual({ kind: "stream", streamId: MALFORMED_RESERVATION_STREAM });
    expect(result.streams[0]?.verdict).toEqual({ row: "N1", category: "unexpected" });
    expect(result.admittedFacts).toEqual([]);
  });

  it("counts N2 on a signup-namespace stream whose suffix does not match the private signup identity shape", () => {
    const result = admitReferralCodeIdentityAndVocabulary(
      [storedEvent(MALFORMED_SIGNUP_STREAM, 0, RECORDED_TYPE)],
      NAMESPACES,
    );
    expect(result.counts).toEqual({ ...CLEAN_COUNTS, unexpected: 1 });
    expect(result.ledger.records[0]?.row).toBe("N2");
    expect(result.ledger.records[0]?.key).toEqual({ kind: "stream", streamId: MALFORMED_SIGNUP_STREAM });
    expect(result.streams[0]?.verdict).toEqual({ row: "N2", category: "unexpected" });
  });

  it("counts F1 on a reservation-classified type observed on a signup stream", () => {
    const result = admitReferralCodeIdentityAndVocabulary(
      [storedEvent(VALID_SIGNUP_STREAM, 0, RESERVED_TYPE, { codeDigest: CANONICAL_SUFFIX })],
      NAMESPACES,
    );
    expect(result.counts).toEqual({ ...CLEAN_COUNTS, unexpected: 1 });
    expect(result.ledger.records[0]?.row).toBe("F1");
    expect(result.ledger.records[0]?.key).toEqual({ kind: "fact", streamId: VALID_SIGNUP_STREAM, streamVersion: 0 });
    expect(result.admittedFacts).toEqual([]);
    expect(result.refusedFactCount).toBe(1);
  });

  it("counts F2 on any type other than the reservation type observed on a phase-one-admitted reservation stream", () => {
    const result = admitReferralCodeIdentityAndVocabulary(
      [issuedFact(CANONICAL_RESERVATION_STREAM, 0, VALID_CODE)],
      NAMESPACES,
    );
    expect(result.counts).toEqual({ ...CLEAN_COUNTS, unexpected: 1 });
    expect(result.ledger.records[0]?.row).toBe("F2");
    expect(result.ledger.records[0]?.key).toEqual({
      kind: "fact",
      streamId: CANONICAL_RESERVATION_STREAM,
      streamVersion: 0,
    });
    expect(result.streams[0]?.verdict).toBeUndefined();
    expect(result.index.issuances[0]?.correlation).toEqual({ kind: "canonical", digest: expectedSha256(VALID_CODE) });
  });

  it("routes an event type in neither runtime set to F1 through the default arm rather than to admitted", () => {
    const result = admitReferralCodeIdentityAndVocabulary(
      [storedEvent(VALID_SIGNUP_STREAM, 0, UNREGISTERED_TYPE)],
      NAMESPACES,
    );
    expect(SIGNUP_RECONCILIATION_EVENT_TYPES).not.toContain(UNREGISTERED_TYPE);
    expect(RESERVATION_RECONCILIATION_EVENT_TYPES).not.toContain(UNREGISTERED_TYPE);
    expect(result.counts).toEqual({ ...CLEAN_COUNTS, unexpected: 1 });
    expect(result.ledger.records[0]?.row).toBe("F1");
    expect(result.admittedFacts).toEqual([]);
  });

  it("admits every well-formed stream and its own classified facts without moving a count", () => {
    const result = admitReferralCodeIdentityAndVocabulary(
      [
        storedEvent(CANONICAL_RESERVATION_STREAM, 0, RESERVED_TYPE, { codeDigest: CANONICAL_SUFFIX }),
        storedEvent(VALID_SIGNUP_STREAM, 0, RECORDED_TYPE),
        issuedFact(VALID_SIGNUP_STREAM, 1, VALID_CODE),
        storedEvent(VALID_SIGNUP_STREAM, 2, PROVISIONED_TYPE, { provisioningId: "wlp_x" }),
      ],
      NAMESPACES,
    );
    expect(result.counts).toEqual(CLEAN_COUNTS);
    expect(result.refusalTotal).toBe(0);
    expect(result.admittedFacts).toHaveLength(4);
    expect(result.ledger.suppressedWrites).toEqual([]);
  });
});

describe("phase-one suppression and totality accounting", () => {
  it("contributes no facts at all from a stream row N2 counted, and reports how many it removed", () => {
    const result = admitReferralCodeIdentityAndVocabulary(
      [
        storedEvent(MALFORMED_SIGNUP_STREAM, 0, RECORDED_TYPE),
        issuedFact(MALFORMED_SIGNUP_STREAM, 1, VALID_CODE),
        storedEvent(MALFORMED_SIGNUP_STREAM, 2, RESERVED_TYPE, { codeDigest: CANONICAL_SUFFIX }),
      ],
      NAMESPACES,
    );

    expect(result.suppressedFactCount).toBe(3);
    expect(result.counts).toEqual({ ...CLEAN_COUNTS, unexpected: 1 });
    expect(result.admittedFacts).toEqual([]);
    expect(result.refusedFactCount).toBe(0);
    expect(result.ledger.records).toHaveLength(1);
    expect(result.ledger.records.every((entry) => entry.key.kind === "stream")).toBe(true);
    expect(result.index.streams[0]?.facts).toHaveLength(3);
  });

  it("accounts every observed fact exactly once across out-of-scope, suppressed, refused and admitted", () => {
    const facts = [
      ...spanningFacts(),
      storedEvent(OUT_OF_SCOPE_STREAM, 0, RECORDED_TYPE),
      storedEvent(VALID_SIGNUP_STREAM, 2, RESERVED_TYPE, { codeDigest: CANONICAL_SUFFIX }),
    ];
    const result = admitReferralCodeIdentityAndVocabulary(facts, NAMESPACES);

    expect(result.observedFactCount).toBe(facts.length);
    expect(
      result.outOfScopeFactCount + result.suppressedFactCount + result.refusedFactCount + result.admittedFacts.length,
    ).toBe(facts.length);
    expect(result.outOfScopeFactCount).toBe(1);
    expect(result.suppressedFactCount).toBe(1);
    expect(result.refusedFactCount).toBe(1);
    expect(result.admittedFacts).toHaveLength(3);
  });

  it("carries each stream's derived kind and parsed suffix so no consumer re-parses a stream id", () => {
    const result = admitReferralCodeIdentityAndVocabulary(
      [
        storedEvent(CANONICAL_RESERVATION_STREAM, 0, RESERVED_TYPE, { codeDigest: CANONICAL_SUFFIX }),
        storedEvent(VALID_SIGNUP_STREAM, 0, RECORDED_TYPE),
      ],
      NAMESPACES,
    );
    console.log("derived streams", JSON.stringify(structuralSnapshot(result.streams), null, 2));

    expect(result.streams).toEqual([
      {
        streamId: CANONICAL_RESERVATION_STREAM,
        kind: "reservation",
        suffix: CANONICAL_SUFFIX,
        verdict: undefined,
        admitted: true,
      },
      {
        streamId: VALID_SIGNUP_STREAM,
        kind: "signup",
        suffix: VALID_SIGNUP_SUFFIX,
        verdict: undefined,
        admitted: true,
      },
    ]);
    expect(CANONICAL_SUFFIX).toBe(expectedSha256(VALID_CODE));
    expect(CANONICAL_SUFFIX).toMatch(lowercaseSha256Pattern);
    expect(VALID_SIGNUP_SUFFIX).toMatch(waitlistSignupIdPattern);
    expect(SECOND_VALID_CODE).not.toBe(VALID_CODE);
  });
});
