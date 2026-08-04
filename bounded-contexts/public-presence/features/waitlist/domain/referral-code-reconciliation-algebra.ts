// Public Referral Code reconciliation subject algebra.
//
// This module owns the vocabulary that every Public Referral Code
// reconciliation slice counts in, plus the identity-and-vocabulary rows that
// are decidable without opening a payload:
//
//   - the four reconciliation subject kinds and their typed keys,
//   - the subject ledger whose first-write-wins rule makes one subject take
//     exactly one count and reports every write it suppressed,
//   - the frozen six-category refusal taxonomy and its exact sum,
//   - the observation index, a total function of observed bytes computed
//     before any verdict exists,
//   - the issuance correlation that decides a code's identity from its value
//     alone, and the derived union of observed issuance suffixes,
//   - the total registry classifier and the two runtime event-type sets
//     derived from it,
//   - rows N1, N2, F1 and F2, in printed order.
//
// Everything here is pure. Nothing reads an Event Store, opens a pool, appends
// an event or emits a receipt. The input is an enumerated fact set plus the two
// literal stream namespaces, both supplied by the caller: the signup namespace
// has no exported constant at this head, and neither namespace is inferred
// here.
//
// Payload discipline: exactly one payload member is read anywhere in this
// module, the issuance payload's public referral code, and only to correlate
// it. Every other payload stays an unread reference. Payload field rules,
// shape rules and value clauses belong to the payload fact admission slice.

import type { PublicPresenceEventPayloads, StoredEvent } from "@chase-sets/event-core";
import type { WaitlistSignupEvent } from "./domain";
import {
  lowercaseSha256Pattern,
  publicReferralCodeDigest,
  publicReferralCodePattern,
  sha256Hex,
  waitlistSignupIdPattern,
} from "./public-referral-code";

/**
 * True only when Left and Right are mutually assignable. Used to pin a derived
 * union against a hand-declared surface in both directions, so a member added
 * to either side without the other is a compile error rather than silent drift.
 */
type MutuallyAssignable<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

/**
 * One JSON value as it is read out of a stored payload, including the absent
 * member. Derived from the store's own payload type rather than re-declared, so
 * a change to the stored payload surface reaches this module as a type error.
 */
export type ObservedPayloadValue = StoredEvent["payload"][string];

// ---------------------------------------------------------------------------
// Refusal taxonomy
// ---------------------------------------------------------------------------

/**
 * The six refusal categories, their names and their order, frozen here and
 * imported unchanged by every downstream reconciliation slice. Renaming or
 * reordering a member is a breaking change to a retained artifact, not a local
 * edit, and no downstream slice may re-spell one as a local literal.
 */
export const RECONCILIATION_REFUSAL_CATEGORIES = [
  "unexpected",
  "mismatched",
  "duplicate",
  "missingRecorded",
  "missingIssued",
  "missingReservation",
] as const;

export type ReconciliationRefusalCategory = (typeof RECONCILIATION_REFUSAL_CATEGORIES)[number];

/**
 * One counter per frozen category. Declared explicitly so the counter surface
 * is readable, and pinned against the category tuple in both directions by
 * RECONCILIATION_REFUSAL_COUNTER_COVERAGE, so a category added to the tuple
 * without a counter here fails the typecheck instead of counting nowhere.
 */
export type ReconciliationRefusalCounts = Readonly<{
  unexpected: number;
  mismatched: number;
  duplicate: number;
  missingRecorded: number;
  missingIssued: number;
  missingReservation: number;
}>;

export const RECONCILIATION_REFUSAL_COUNTER_COVERAGE: MutuallyAssignable<
  ReconciliationRefusalCategory,
  keyof ReconciliationRefusalCounts
> = true;

type MutableReconciliationRefusalCounts = { -readonly [Category in ReconciliationRefusalCategory]: number };

function createMutableRefusalCounts(): MutableReconciliationRefusalCounts {
  const counts: Partial<MutableReconciliationRefusalCounts> = {};
  for (const category of RECONCILIATION_REFUSAL_CATEGORIES) {
    counts[category] = 0;
  }
  return counts as MutableReconciliationRefusalCounts;
}

/** A fresh, frozen count object with every category at zero. */
export function cleanReconciliationRefusalCounts(): ReconciliationRefusalCounts {
  return Object.freeze(createMutableRefusalCounts());
}

/** The exact sum of the six counts, summed over the exported category tuple. */
export function reconciliationRefusalTotal(counts: ReconciliationRefusalCounts): number {
  let total = 0;
  for (const category of RECONCILIATION_REFUSAL_CATEGORIES) {
    total += counts[category];
  }
  return total;
}

// ---------------------------------------------------------------------------
// Subject keys and the subject ledger
// ---------------------------------------------------------------------------

/**
 * A reconciliation subject key. Exactly four kinds, each carrying its own
 * members. Never a concatenated string: a joined key lets a stream subject and
 * a fact subject collide on a stream id that happens to end in a
 * version-shaped suffix, which is how two independent defects on one stream
 * silently become one count.
 */
export type ReconciliationSubjectKey =
  | Readonly<{ kind: "stream"; streamId: string }>
  | Readonly<{ kind: "fact"; streamId: string; streamVersion: number }>
  | Readonly<{ kind: "issued-digest"; digest: string }>
  | Readonly<{ kind: "provisioning-identity"; provisioningId: string }>;

export type ReconciliationSubjectKind = ReconciliationSubjectKey["kind"];

export type ReconciliationSubjectRecord = Readonly<{
  key: ReconciliationSubjectKey;
  row: string;
  category: ReconciliationRefusalCategory;
}>;

export type ReconciliationSubjectLedgerResult = Readonly<{
  counts: ReconciliationRefusalCounts;
  refusalTotal: number;
  records: readonly ReconciliationSubjectRecord[];
  suppressedWrites: readonly ReconciliationSubjectRecord[];
}>;

export type ReconciliationSubjectLedger = Readonly<{
  /** Records on a fresh key and returns true; changes nothing and returns false on a held key. */
  record: (key: ReconciliationSubjectKey, row: string, category: ReconciliationRefusalCategory) => boolean;
  recordedFor: (key: ReconciliationSubjectKey) => ReconciliationSubjectRecord | undefined;
  result: () => ReconciliationSubjectLedgerResult;
}>;

export function streamSubjectKey(streamId: string): ReconciliationSubjectKey {
  return Object.freeze({ kind: "stream", streamId });
}

export function factSubjectKey(streamId: string, streamVersion: number): ReconciliationSubjectKey {
  return Object.freeze({ kind: "fact", streamId, streamVersion });
}

export function issuedDigestSubjectKey(digest: string): ReconciliationSubjectKey {
  return Object.freeze({ kind: "issued-digest", digest });
}

export function provisioningIdentitySubjectKey(provisioningId: string): ReconciliationSubjectKey {
  return Object.freeze({ kind: "provisioning-identity", provisioningId });
}

/**
 * The ledger that makes one subject take exactly one count. The first write on
 * a key wins; every later write on that key changes neither the recorded row
 * nor the recorded category, counts nothing, and is appended to the suppressed
 * write inventory with the row that attempted it and the category it would have
 * moved. Two rows writing one key therefore move one count, and two rows
 * writing two keys of different kinds move two, by construction rather than by
 * convention.
 *
 * Subjects are held in one map per kind, and fact subjects in a map of stream
 * id to a map of stream version, so no two keys of different kinds and no two
 * fact keys can share a slot.
 */
export function createReconciliationSubjectLedger(): ReconciliationSubjectLedger {
  const streamEntries = new Map<string, ReconciliationSubjectRecord>();
  const factEntries = new Map<string, Map<number, ReconciliationSubjectRecord>>();
  const issuedDigestEntries = new Map<string, ReconciliationSubjectRecord>();
  const provisioningIdentityEntries = new Map<string, ReconciliationSubjectRecord>();
  const counts = createMutableRefusalCounts();
  const records: ReconciliationSubjectRecord[] = [];
  const suppressedWrites: ReconciliationSubjectRecord[] = [];

  function held(key: ReconciliationSubjectKey): ReconciliationSubjectRecord | undefined {
    switch (key.kind) {
      case "stream":
        return streamEntries.get(key.streamId);
      case "fact":
        return factEntries.get(key.streamId)?.get(key.streamVersion);
      case "issued-digest":
        return issuedDigestEntries.get(key.digest);
      case "provisioning-identity":
        return provisioningIdentityEntries.get(key.provisioningId);
      default: {
        const unreachable: never = key;
        return unreachable;
      }
    }
  }

  function hold(entry: ReconciliationSubjectRecord): void {
    const key = entry.key;
    switch (key.kind) {
      case "stream":
        streamEntries.set(key.streamId, entry);
        return;
      case "fact": {
        const versions = factEntries.get(key.streamId) ?? new Map<number, ReconciliationSubjectRecord>();
        versions.set(key.streamVersion, entry);
        factEntries.set(key.streamId, versions);
        return;
      }
      case "issued-digest":
        issuedDigestEntries.set(key.digest, entry);
        return;
      case "provisioning-identity":
        provisioningIdentityEntries.set(key.provisioningId, entry);
        return;
      default: {
        const unreachable: never = key;
        return unreachable;
      }
    }
  }

  return Object.freeze({
    record(key: ReconciliationSubjectKey, row: string, category: ReconciliationRefusalCategory): boolean {
      const attempted: ReconciliationSubjectRecord = Object.freeze({ key, row, category });
      if (held(key)) {
        suppressedWrites.push(attempted);
        return false;
      }
      hold(attempted);
      records.push(attempted);
      counts[category] += 1;
      return true;
    },
    recordedFor(key: ReconciliationSubjectKey): ReconciliationSubjectRecord | undefined {
      return held(key);
    },
    result(): ReconciliationSubjectLedgerResult {
      return Object.freeze({
        counts: Object.freeze({ ...counts }),
        refusalTotal: reconciliationRefusalTotal(counts),
        records: Object.freeze([...records]),
        suppressedWrites: Object.freeze([...suppressedWrites]),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Vocabulary: one total classifier over the closed public payload registry
// ---------------------------------------------------------------------------

export type ReconciliationEventClass = "signup" | "reservation" | "outside-reconciliation";

/**
 * The total classifier. The mapped type it satisfies rejects both a missing key
 * and an excess key, so an eighth public payload registry key fails the
 * typecheck until it is classified rather than silently entering or silently
 * leaving the accepted vocabulary.
 *
 * An Exclude subtraction against the signup event union is deliberately not
 * used: it would make every future unrelated registry key an accepted
 * reservation event with no typecheck failure at all.
 */
export const PUBLIC_PRESENCE_RECONCILIATION_CLASS = {
  "public-presence.waitlist-signup.recorded": "signup",
  "public-presence.waitlist-signup.updated": "signup",
  "public-presence.waitlist-signup.cohort-quality-provided": "signup",
  "public-presence.waitlist-signup.admitted": "signup",
  "public-presence.waitlist-referral-code.reserved": "reservation",
  "public-presence.waitlist-referral-code.issued": "signup",
  "public-presence.waitlist-referral-link.provisioned": "signup",
} as const satisfies { readonly [Key in keyof PublicPresenceEventPayloads]: ReconciliationEventClass };

type SignupClassifiedEventType = {
  [Key in keyof typeof PUBLIC_PRESENCE_RECONCILIATION_CLASS]: (typeof PUBLIC_PRESENCE_RECONCILIATION_CLASS)[Key] extends "signup"
    ? Key
    : never;
}[keyof typeof PUBLIC_PRESENCE_RECONCILIATION_CLASS];

/**
 * Pins the signup class against the waitlist signup event union in both
 * directions, so a seventh domain variant, or a registry key classified signup
 * that is not a domain variant, is a red typecheck rather than a vocabulary
 * change nobody noticed.
 */
export const SIGNUP_CLASS_MATCHES_WAITLIST_SIGNUP_EVENTS: MutuallyAssignable<
  SignupClassifiedEventType,
  WaitlistSignupEvent["type"]
> = true;

function reconciliationEventTypesOfClass(target: ReconciliationEventClass): readonly string[] {
  const registry: Readonly<Record<string, ReconciliationEventClass>> = PUBLIC_PRESENCE_RECONCILIATION_CLASS;
  return Object.freeze(Object.keys(PUBLIC_PRESENCE_RECONCILIATION_CLASS).filter((key) => registry[key] === target));
}

/** Built from the classifier's own keys, never hand-listed, so runtime membership cannot drift from the compile-time surface. */
export const SIGNUP_RECONCILIATION_EVENT_TYPES: readonly string[] = reconciliationEventTypesOfClass("signup");

export const RESERVATION_RECONCILIATION_EVENT_TYPES: readonly string[] = reconciliationEventTypesOfClass("reservation");

export type ObservedEventTypeClass = ReconciliationEventClass | "unregistered";

/**
 * Total over every observed event type. A type absent from the closed registry,
 * and any value the registry lookup could not resolve to one of the three
 * declared classes, resolves through the default arm to "unregistered" rather
 * than being treated as accepted vocabulary.
 */
export function observedEventTypeClass(eventType: string): ObservedEventTypeClass {
  if (!Object.hasOwn(PUBLIC_PRESENCE_RECONCILIATION_CLASS, eventType)) {
    return "unregistered";
  }
  const registry: Readonly<Record<string, ReconciliationEventClass>> = PUBLIC_PRESENCE_RECONCILIATION_CLASS;
  const classified = registry[eventType];
  switch (classified) {
    case "signup":
    case "reservation":
    case "outside-reconciliation":
      return classified;
    default:
      return "unregistered";
  }
}

const ISSUED_EVENT_TYPE =
  "public-presence.waitlist-referral-code.issued" as const satisfies keyof PublicPresenceEventPayloads;

const ISSUED_CODE_MEMBER =
  "publicReferralCode" as const satisfies keyof PublicPresenceEventPayloads[typeof ISSUED_EVENT_TYPE];

// ---------------------------------------------------------------------------
// Issuance correlation
// ---------------------------------------------------------------------------

/**
 * The identity an observed issuance carries, decided by the observed value
 * alone. No verdict is readable from this function and none is an input to it.
 */
export type IssuanceCorrelation =
  | Readonly<{ kind: "canonical"; digest: string }>
  | Readonly<{ kind: "opaque"; fingerprint: string }>
  | Readonly<{ kind: "uncorrelatable" }>;

export const UNCORRELATABLE_ISSUANCE_CORRELATION: IssuanceCorrelation = Object.freeze({ kind: "uncorrelatable" });

function canonicalIssuanceCorrelation(value: string): IssuanceCorrelation {
  return Object.freeze({ kind: "canonical", digest: publicReferralCodeDigest(value) });
}

function opaqueIssuanceCorrelation(value: string): IssuanceCorrelation {
  return Object.freeze({ kind: "opaque", fingerprint: sha256Hex(value) });
}

/**
 * Total over the JSON value space, including the absent member, with an
 * explicit default arm rather than a fall-through chain.
 *
 * A string that matches the imported code pattern is canonical, and only then
 * is the canonical digest helper reached at all: that helper asserts the same
 * pattern and throws, so a value that has not matched must never be handed to
 * it. Any other string is fingerprinted through the unvalidated hash helper,
 * which puts canonical digests and opaque fingerprints in one digest space and
 * makes their union an exact match set. Every non-string value, and an absent
 * member, is uncorrelatable.
 *
 * There is no coercion of any kind here, deliberately: coercing a non-string
 * before hashing would mint an identity out of bytes production never hashed
 * and could collide with a real reservation.
 */
export function correlateIssuedPublicReferralCode(value: ObservedPayloadValue): IssuanceCorrelation {
  switch (typeof value) {
    case "string": {
      if (publicReferralCodePattern.test(value)) {
        return canonicalIssuanceCorrelation(value);
      }
      return opaqueIssuanceCorrelation(value);
    }
    default:
      return UNCORRELATABLE_ISSUANCE_CORRELATION;
  }
}

/**
 * The suffix an issuance contributes to the observed issuance union, or nothing
 * when the value is uncorrelatable. An uncorrelatable value supplies no
 * evidence linking an issuance to a reservation stream, so it must contribute
 * no member rather than a placeholder.
 */
function issuanceCorrelationSuffix(correlation: IssuanceCorrelation): string | undefined {
  switch (correlation.kind) {
    case "canonical":
      return correlation.digest;
    case "opaque":
      return correlation.fingerprint;
    case "uncorrelatable":
      return undefined;
    default: {
      const unreachable: never = correlation;
      return unreachable;
    }
  }
}

// ---------------------------------------------------------------------------
// Observation index
// ---------------------------------------------------------------------------

export type ReconciliationStreamKind = "signup" | "reservation";

/**
 * The two literal stream namespaces the caller scopes with. Neither is inferred
 * here and neither may be a prefix of the other; scoping the fact set to them
 * is the caller's responsibility.
 */
export type ReconciliationStreamNamespaces = Readonly<{
  reservationStreamPrefix: string;
  signupStreamPrefix: string;
}>;

/**
 * One observed fact. The payload is the caller's own object, referenced and
 * never copied, never mutated and never frozen, so building the index leaves
 * the caller's fact set exactly as it was found.
 */
export type ObservedFact = Readonly<{
  streamId: string;
  streamVersion: number;
  eventType: string;
  payload: StoredEvent["payload"];
}>;

export type ObservedEventTypeGroup = Readonly<{
  eventType: string;
  facts: readonly ObservedFact[];
}>;

export type ObservedStream = Readonly<{
  streamId: string;
  kind: ReconciliationStreamKind;
  suffix: string;
  facts: readonly ObservedFact[];
  factsByEventType: readonly ObservedEventTypeGroup[];
}>;

export type ObservedIssuance = Readonly<{
  streamId: string;
  streamVersion: number;
  correlation: IssuanceCorrelation;
}>;

/**
 * A total function of observed bytes. Every in-scope fact on every in-scope
 * stream enters it, including streams and facts a later row refuses, and no
 * member of it is conditional on a verdict. That is the structural reason a
 * refusal can never become the reason another subject is refused.
 *
 * The observed issuance suffixes are a deduplicated union in first-observation
 * order rather than a native Set: Object.freeze does not make a Set immutable,
 * so a Set would report as frozen while a consumer narrowed or widened it.
 */
export type ReferralCodeObservationIndex = Readonly<{
  streams: readonly ObservedStream[];
  reservationStreamIds: readonly string[];
  issuances: readonly ObservedIssuance[];
  observedIssuanceSuffixes: readonly string[];
  outOfScopeFactCount: number;
}>;

type ScopedStreamIdentity = Readonly<{ kind: ReconciliationStreamKind; suffix: string }>;

function scopeStreamIdentity(
  streamId: string,
  namespaces: ReconciliationStreamNamespaces,
): ScopedStreamIdentity | undefined {
  if (streamId.startsWith(namespaces.reservationStreamPrefix)) {
    return { kind: "reservation", suffix: streamId.slice(namespaces.reservationStreamPrefix.length) };
  }
  if (streamId.startsWith(namespaces.signupStreamPrefix)) {
    return { kind: "signup", suffix: streamId.slice(namespaces.signupStreamPrefix.length) };
  }
  return undefined;
}

type DraftStream = {
  streamId: string;
  kind: ReconciliationStreamKind;
  suffix: string;
  facts: ObservedFact[];
  groupOrder: string[];
  groups: Map<string, ObservedFact[]>;
};

/**
 * Builds the observation index in one pass over the enumerated fact set. A fact
 * whose stream carries neither supplied namespace is accounted in the
 * out-of-scope count, enters no index entry, and is never thrown on.
 */
export function buildReferralCodeObservationIndex(
  facts: readonly StoredEvent[],
  namespaces: ReconciliationStreamNamespaces,
): ReferralCodeObservationIndex {
  const drafts = new Map<string, DraftStream>();
  const draftOrder: string[] = [];
  const reservationStreamIds: string[] = [];
  const issuances: ObservedIssuance[] = [];
  const observedIssuanceSuffixes: string[] = [];
  const seenIssuanceSuffixes = new Set<string>();
  let outOfScopeFactCount = 0;

  for (const fact of facts) {
    const scoped = scopeStreamIdentity(fact.streamId, namespaces);
    if (scoped === undefined) {
      outOfScopeFactCount += 1;
      continue;
    }

    let draft = drafts.get(fact.streamId);
    if (draft === undefined) {
      draft = {
        streamId: fact.streamId,
        kind: scoped.kind,
        suffix: scoped.suffix,
        facts: [],
        groupOrder: [],
        groups: new Map<string, ObservedFact[]>(),
      };
      drafts.set(fact.streamId, draft);
      draftOrder.push(fact.streamId);
      if (scoped.kind === "reservation") {
        reservationStreamIds.push(fact.streamId);
      }
    }

    const observed: ObservedFact = Object.freeze({
      streamId: fact.streamId,
      streamVersion: fact.streamVersion,
      eventType: fact.eventType,
      payload: fact.payload,
    });
    draft.facts.push(observed);
    let group = draft.groups.get(fact.eventType);
    if (group === undefined) {
      group = [];
      draft.groups.set(fact.eventType, group);
      draft.groupOrder.push(fact.eventType);
    }
    group.push(observed);

    if (fact.eventType === ISSUED_EVENT_TYPE) {
      const correlation = correlateIssuedPublicReferralCode(fact.payload[ISSUED_CODE_MEMBER]);
      issuances.push(Object.freeze({ streamId: fact.streamId, streamVersion: fact.streamVersion, correlation }));
      const suffix = issuanceCorrelationSuffix(correlation);
      if (suffix !== undefined && !seenIssuanceSuffixes.has(suffix)) {
        seenIssuanceSuffixes.add(suffix);
        observedIssuanceSuffixes.push(suffix);
      }
    }
  }

  const streams = draftOrder.map((streamId) => freezeDraftStream(drafts.get(streamId) as DraftStream));

  return Object.freeze({
    streams: Object.freeze(streams),
    reservationStreamIds: Object.freeze(reservationStreamIds),
    issuances: Object.freeze(issuances),
    observedIssuanceSuffixes: Object.freeze(observedIssuanceSuffixes),
    outOfScopeFactCount,
  });
}

function freezeDraftStream(draft: DraftStream): ObservedStream {
  const factsByEventType = draft.groupOrder.map((eventType) =>
    Object.freeze({
      eventType,
      facts: Object.freeze([...(draft.groups.get(eventType) as ObservedFact[])]),
    }),
  );
  return Object.freeze({
    streamId: draft.streamId,
    kind: draft.kind,
    suffix: draft.suffix,
    facts: Object.freeze([...draft.facts]),
    factsByEventType: Object.freeze(factsByEventType),
  });
}

// ---------------------------------------------------------------------------
// Rows N1, N2, F1 and F2, in printed order
// ---------------------------------------------------------------------------

export type ReferralCodeIdentityRow = "N1" | "N2";

export type ReferralCodeVocabularyRow = "F1" | "F2";

export type StreamPhaseOneVerdict = Readonly<{
  row: ReferralCodeIdentityRow;
  category: ReconciliationRefusalCategory;
}>;

export type FactPhaseTwoVerdict = Readonly<{
  row: ReferralCodeVocabularyRow;
  category: ReconciliationRefusalCategory;
}>;

/** N1: a reservation-namespace stream whose suffix is not a lowercase 64-hex digest. */
const ROW_N1: StreamPhaseOneVerdict = Object.freeze({ row: "N1", category: "unexpected" });

/** N2: a signup-namespace stream whose suffix is not a private waitlist signup identity. */
const ROW_N2: StreamPhaseOneVerdict = Object.freeze({ row: "N2", category: "unexpected" });

/** F1: a type not classified signup, on a signup stream. */
const ROW_F1: FactPhaseTwoVerdict = Object.freeze({ row: "F1", category: "unexpected" });

/** F2: any type other than the reservation type, on a phase-one-admitted reservation stream. */
const ROW_F2: FactPhaseTwoVerdict = Object.freeze({ row: "F2", category: "unexpected" });

/**
 * Rows N1 and N2. Each judges a stream's parsed suffix against the shape its
 * namespace requires, using the imported pattern rather than a second copy of
 * its text.
 */
export function streamPhaseOneVerdict(stream: ObservedStream): StreamPhaseOneVerdict | undefined {
  switch (stream.kind) {
    case "reservation":
      return lowercaseSha256Pattern.test(stream.suffix) ? undefined : ROW_N1;
    case "signup":
      return waitlistSignupIdPattern.test(stream.suffix) ? undefined : ROW_N2;
    default: {
      const unreachable: never = stream.kind;
      return unreachable;
    }
  }
}

/**
 * Rows F1 and F2. Admission requires an explicit class match; every other
 * class, including a type the closed registry does not declare at all, reaches
 * the default arm and is refused rather than falling through to admitted.
 */
export function factPhaseTwoVerdict(
  streamKind: ReconciliationStreamKind,
  eventType: string,
): FactPhaseTwoVerdict | undefined {
  const classified = observedEventTypeClass(eventType);
  switch (streamKind) {
    case "signup":
      switch (classified) {
        case "signup":
          return undefined;
        default:
          return ROW_F1;
      }
    case "reservation":
      switch (classified) {
        case "reservation":
          return undefined;
        default:
          return ROW_F2;
      }
    default: {
      const unreachable: never = streamKind;
      return unreachable;
    }
  }
}

export type AdmittedStream = Readonly<{
  streamId: string;
  kind: ReconciliationStreamKind;
  suffix: string;
  verdict: StreamPhaseOneVerdict | undefined;
  admitted: boolean;
}>;

export type ReferralCodeIdentityAdmission = Readonly<{
  index: ReferralCodeObservationIndex;
  streams: readonly AdmittedStream[];
  admittedFacts: readonly ObservedFact[];
  ledger: ReconciliationSubjectLedgerResult;
  counts: ReconciliationRefusalCounts;
  refusalTotal: number;
  observedFactCount: number;
  outOfScopeFactCount: number;
  suppressedFactCount: number;
  refusedFactCount: number;
}>;

/**
 * Runs rows N1, N2, F1 and F2 in printed order over an enumerated fact set.
 *
 * Phase one judges stream identity before any fact is inspected. A stream a
 * phase-one row counts contributes no facts at all: its facts are excluded from
 * the admitted set, are evaluated by no row, and are reported in the suppressed
 * fact count. That is the one removal key collision cannot express, because a
 * stream key and a fact key are different keys.
 *
 * Phase two judges whether an observed event type is admissible on the stream
 * kind it was found on. Every fact is accounted exactly once: the observed fact
 * count is the exact sum of the out-of-scope, suppressed, refused and admitted
 * counts.
 */
export function admitReferralCodeIdentityAndVocabulary(
  facts: readonly StoredEvent[],
  namespaces: ReconciliationStreamNamespaces,
): ReferralCodeIdentityAdmission {
  const index = buildReferralCodeObservationIndex(facts, namespaces);
  const ledger = createReconciliationSubjectLedger();
  const streams: AdmittedStream[] = [];
  const admittedFacts: ObservedFact[] = [];
  let suppressedFactCount = 0;
  let refusedFactCount = 0;

  for (const stream of index.streams) {
    const verdict = streamPhaseOneVerdict(stream);
    if (verdict !== undefined) {
      ledger.record(streamSubjectKey(stream.streamId), verdict.row, verdict.category);
      suppressedFactCount += stream.facts.length;
    }
    streams.push(
      Object.freeze({
        streamId: stream.streamId,
        kind: stream.kind,
        suffix: stream.suffix,
        verdict,
        admitted: verdict === undefined,
      }),
    );
  }

  for (const stream of index.streams) {
    if (streamPhaseOneVerdict(stream) !== undefined) {
      continue;
    }
    for (const fact of stream.facts) {
      const verdict = factPhaseTwoVerdict(stream.kind, fact.eventType);
      if (verdict === undefined) {
        admittedFacts.push(fact);
        continue;
      }
      ledger.record(factSubjectKey(fact.streamId, fact.streamVersion), verdict.row, verdict.category);
      refusedFactCount += 1;
    }
  }

  const ledgerResult = ledger.result();

  return Object.freeze({
    index,
    streams: Object.freeze(streams),
    admittedFacts: Object.freeze(admittedFacts),
    ledger: ledgerResult,
    counts: ledgerResult.counts,
    refusalTotal: ledgerResult.refusalTotal,
    observedFactCount: facts.length,
    outOfScopeFactCount: index.outOfScopeFactCount,
    suppressedFactCount,
    refusedFactCount,
  });
}
