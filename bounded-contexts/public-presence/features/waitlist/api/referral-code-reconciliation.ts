import type { EventStore, EventStoreError } from "@chase-sets/event-core/event-store";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import {
  EVENT_STORE_READ_PAGE_SIZE_MAX,
  ZERO_GLOBAL_POSITION,
  type EventStoreContext,
  type GlobalPosition,
  type StoredEvent,
} from "@chase-sets/event-core/storage";
import { readGapSafeEventStoreHead, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  createPublicReferralCodeCoverageReceipt,
  generatePublicReferralCode,
  publicReferralCodeDigest,
  type PublicReferralCodeCoverageReceipt,
  type SecureRandomBytes,
} from "../domain/public-referral-code";

const SIGNUP_STREAM_PREFIX = "public-presence.waitlist-signup-";
const RESERVATION_STREAM_PREFIX = "public-presence.waitlist-referral-code-";
const INVENTORY_EVENT_TYPES = [
  "public-presence.waitlist-signup.recorded",
  "public-presence.waitlist-referral-code.issued",
  "public-presence.waitlist-referral-code.reserved",
] as const;
const ALLOWED_SIGNUP_EVENT_TYPES = new Set([
  "public-presence.waitlist-signup.recorded",
  "public-presence.waitlist-signup.updated",
  "public-presence.waitlist-signup.cohort-quality-provided",
  "public-presence.waitlist-signup.admitted",
  "public-presence.waitlist-referral-code.issued",
  "public-presence.waitlist-referral-link.provisioned",
]);

export type ReconcilePublicReferralCodesInput = Readonly<{
  context: EventStoreContext;
}>;

export type PublicReferralCodeReconciliationDependencies = Readonly<{
  eventStore: EventStore;
  pool?: PgTransactionalPool;
  now?: () => Date;
  randomBytes?: SecureRandomBytes;
  afterSignupReconciled?: (signupId: string) => Promise<void> | void;
}>;

export function createPublicReferralCodeReconciliation(deps: PublicReferralCodeReconciliationDependencies) {
  return async function reconcilePublicReferralCodes(
    input: ReconcilePublicReferralCodesInput,
  ): Promise<PublicReferralCodeCoverageReceipt> {
    const appendToStreams = deps.eventStore.appendToStreams;
    if (!appendToStreams) {
      throw new Error("Public Referral Code reconciliation requires EventStore.appendToStreams.");
    }
    if (!deps.pool) {
      throw new Error("Public Referral Code reconciliation requires the Public Presence PostgreSQL pool.");
    }

    const now = deps.now ?? (() => new Date());
    const startedAt = now().toISOString();
    const horizon = await readGapSafeEventStoreHead(deps.pool);
    const inventory = await readInventoryThroughHorizon(deps.eventStore, horizon);
    const signupStreamIds = new Set<string>();
    const reservationDigestsAtHorizon = new Set<string>();

    for (const event of inventory) {
      if (event.eventType === "public-presence.waitlist-signup.recorded") signupStreamIds.add(event.streamId);
      if (event.eventType === "public-presence.waitlist-referral-code.issued") signupStreamIds.add(event.streamId);
      if (event.eventType === "public-presence.waitlist-referral-code.reserved") {
        const digest = readString(event.payload.codeDigest);
        if (digest) reservationDigestsAtHorizon.add(digest);
      }
    }

    const refusals = {
      missingRecorded: 0,
      missingIssued: 0,
      missingReservation: 0,
      mismatched: 0,
      duplicate: 0,
      unexpected: 0,
    };
    const outcomes: SignupOutcome[] = [];

    for (const streamId of [...signupStreamIds].sort()) {
      const outcome = await reconcileSignup({
        eventStore: deps.eventStore,
        appendToStreams,
        streamId,
        context: input.context,
        now,
        randomBytes: deps.randomBytes,
      });
      outcomes.push(outcome);
      await deps.afterSignupReconciled?.(outcome.signupId ?? streamId);
    }

    const digestFrequency = new Map<string, number>();
    for (const outcome of outcomes) {
      if (outcome.reservationDigest) {
        digestFrequency.set(outcome.reservationDigest, (digestFrequency.get(outcome.reservationDigest) ?? 0) + 1);
      }
    }

    let completeSignupCount = 0;
    let validIssuedCount = 0;
    const matchedReservationDigests = new Set<string>();
    const validReservationDigests = new Set<string>();
    for (const outcome of outcomes) {
      if (outcome.hasRecorded) completeSignupCount += 1;
      const duplicateDigest =
        outcome.reservationDigest !== null && (digestFrequency.get(outcome.reservationDigest) ?? 0) > 1;
      if (outcome.validIssued && !duplicateDigest) validIssuedCount += 1;
      if (outcome.validReservation && outcome.reservationDigest) {
        matchedReservationDigests.add(outcome.reservationDigest);
        if (!duplicateDigest) validReservationDigests.add(outcome.reservationDigest);
      }
      for (const refusal of new Set([...outcome.refusals, ...(duplicateDigest ? (["duplicate"] as const) : [])])) {
        refusals[refusal] += 1;
      }
    }

    for (const digest of reservationDigestsAtHorizon) {
      if (!matchedReservationDigests.has(digest)) refusals.missingRecorded += 1;
    }

    const validReservedCount = validReservationDigests.size;
    const refusalTotal = Object.values(refusals).reduce((total, count) => total + count, 0);
    const completedAt = now().toISOString();
    return createPublicReferralCodeCoverageReceipt({
      horizonGlobalPosition: horizon,
      completeSignupCount,
      validIssuedCount,
      validReservedCount,
      refusalCounts: refusals,
      cutoverEligible:
        completeSignupCount === validIssuedCount && completeSignupCount === validReservedCount && refusalTotal === 0,
      startedAt,
      completedAt,
    });
  };
}

async function readInventoryThroughHorizon(
  eventStore: EventStore,
  horizon: GlobalPosition,
): Promise<readonly StoredEvent[]> {
  const events: StoredEvent[] = [];
  let afterGlobalPosition = ZERO_GLOBAL_POSITION;

  for (;;) {
    const page = await eventStore.readAll({
      afterGlobalPosition,
      atOrBeforeGlobalPosition: horizon,
      eventTypes: INVENTORY_EVENT_TYPES,
      limit: EVENT_STORE_READ_PAGE_SIZE_MAX,
    });
    if (page.length > EVENT_STORE_READ_PAGE_SIZE_MAX)
      throw new Error("Event Store returned an oversized inventory page.");
    events.push(...page);
    if (page.length < EVENT_STORE_READ_PAGE_SIZE_MAX) return events;
    const last = page.at(-1);
    if (!last || last.globalPosition === afterGlobalPosition)
      throw new Error("Event Store inventory cursor did not advance.");
    afterGlobalPosition = last.globalPosition;
  }
}

type RefusalKey =
  | "missingRecorded"
  | "missingIssued"
  | "missingReservation"
  | "mismatched"
  | "duplicate"
  | "unexpected";

type SignupOutcome = Readonly<{
  signupId: string | null;
  hasRecorded: boolean;
  validIssued: boolean;
  validReservation: boolean;
  reservationDigest: string | null;
  refusals: readonly RefusalKey[];
}>;

async function reconcileSignup(
  input: Readonly<{
    eventStore: EventStore;
    appendToStreams: NonNullable<EventStore["appendToStreams"]>;
    streamId: string;
    context: EventStoreContext;
    now: () => Date;
    randomBytes?: SecureRandomBytes;
  }>,
): Promise<SignupOutcome> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const history = await readCompleteStream(input.eventStore, { streamId: input.streamId });
    const semantic = inspectSignupHistory(input.streamId, history);
    if (semantic.refusals.length > 0 || !semantic.hasRecorded) return semantic;

    if (semantic.publicReferralCode) {
      const digest = publicReferralCodeDigest(semantic.publicReferralCode);
      const reservation = await inspectReservation(input.eventStore, digest);
      if (reservation.kind === "valid") {
        return { ...semantic, validIssued: true, validReservation: true, reservationDigest: digest };
      }
      if (reservation.kind === "poison") {
        return {
          ...semantic,
          validIssued: true,
          validReservation: false,
          reservationDigest: digest,
          refusals: [reservation.refusal],
        };
      }
      try {
        await input.appendToStreams([reservationAppend(digest, input.now().toISOString(), input.context)]);
        return { ...semantic, validIssued: true, validReservation: true, reservationDigest: digest };
      } catch (error) {
        if (isConcurrencyConflict(error)) continue;
        throw error;
      }
    }

    const publicReferralCode = generatePublicReferralCode(input.randomBytes);
    const digest = publicReferralCodeDigest(publicReferralCode);
    const issuedAt = input.now().toISOString();
    try {
      await input.appendToStreams([
        reservationAppend(digest, issuedAt, input.context),
        {
          streamId: input.streamId,
          wakeSourceContextName: "public-presence",
          expectedVersion: history.at(-1)?.streamVersion ?? 0,
          context: input.context,
          events: [
            {
              eventType: "public-presence.waitlist-referral-code.issued",
              payload: { signupId: semantic.signupId!, publicReferralCode, issuedAt },
            },
          ],
        },
      ]);
      return {
        ...semantic,
        validIssued: true,
        validReservation: true,
        reservationDigest: digest,
      };
    } catch (error) {
      if (isConcurrencyConflict(error)) continue;
      throw error;
    }
  }
  throw new Error(`Public Referral Code reconciliation could not settle concurrent history for ${input.streamId}.`);
}

function inspectSignupHistory(
  streamId: string,
  history: readonly StoredEvent[],
): SignupOutcome & {
  publicReferralCode: string | null;
} {
  const refusals: RefusalKey[] = [];
  if (!streamId.startsWith(SIGNUP_STREAM_PREFIX)) refusals.push("mismatched");
  if (history.some((event) => !ALLOWED_SIGNUP_EVENT_TYPES.has(event.eventType))) refusals.push("unexpected");
  const recorded = history.filter((event) => event.eventType === "public-presence.waitlist-signup.recorded");
  const issued = history.filter((event) => event.eventType === "public-presence.waitlist-referral-code.issued");
  if (recorded.length === 0) refusals.push("missingRecorded");
  if (recorded.length > 1 || issued.length > 1) refusals.push("duplicate");
  const signupId = readString(recorded[0]?.payload.signupId) ?? readString(issued[0]?.payload.signupId);
  const expectedSignupId = streamId.slice(SIGNUP_STREAM_PREFIX.length);
  if (signupId && signupId !== expectedSignupId) refusals.push("mismatched");
  const issuedSignupId = readString(issued[0]?.payload.signupId);
  if (issuedSignupId && signupId && issuedSignupId !== signupId) refusals.push("mismatched");
  const publicReferralCode = readString(issued[0]?.payload.publicReferralCode);
  if (recorded.length === 1 && !isValidRecordedPayload(recorded[0].payload)) refusals.push("mismatched");
  if (recorded.length === 1 && history[0]?.eventType !== "public-presence.waitlist-signup.recorded") {
    refusals.push("unexpected");
  }
  if (
    history.some((event) => {
      const eventSignupId = readString(event.payload.signupId);
      return eventSignupId !== null && signupId !== null && eventSignupId !== signupId;
    })
  ) {
    refusals.push("mismatched");
  }
  if (signupId && history.some((event) => !isValidSignupEventPayload(event, signupId))) {
    refusals.push("mismatched");
  }
  const issuedIndex = history.findIndex((event) => event.eventType === "public-presence.waitlist-referral-code.issued");
  if (
    history.some(
      (event, index) =>
        event.eventType === "public-presence.waitlist-referral-link.provisioned" &&
        (issuedIndex < 0 || index < issuedIndex),
    )
  ) {
    refusals.push("unexpected");
  }
  if (issued.length === 1 && (!publicReferralCode || !isValidIssuedPayload(issued[0].payload))) {
    refusals.push("mismatched");
  }
  if (issued.length === 0 && refusals.length > 0 && recorded.length === 1) refusals.push("missingIssued");

  return {
    signupId,
    hasRecorded: recorded.length === 1 && Boolean(signupId),
    publicReferralCode,
    validIssued: issued.length === 1 && Boolean(publicReferralCode) && refusals.length === 0,
    validReservation: false,
    reservationDigest: null,
    refusals: [...new Set(refusals)],
  };
}

async function inspectReservation(
  eventStore: EventStore,
  digest: string,
): Promise<
  Readonly<{ kind: "missing" }> | Readonly<{ kind: "valid" }> | Readonly<{ kind: "poison"; refusal: RefusalKey }>
> {
  const streamId = `${RESERVATION_STREAM_PREFIX}${digest}`;
  const history = await readCompleteStream(eventStore, { streamId });
  if (history.length === 0) return { kind: "missing" };
  if (history.length !== 1) return { kind: "poison", refusal: "duplicate" };
  const event = history[0];
  if (event.eventType !== "public-presence.waitlist-referral-code.reserved") {
    return { kind: "poison", refusal: "unexpected" };
  }
  if (
    !hasExactKeys(event.payload, ["codeDigest", "reservedAt"]) ||
    readString(event.payload.codeDigest) !== digest ||
    !isUtcMillisecondInstant(event.payload.reservedAt)
  ) {
    return { kind: "poison", refusal: "mismatched" };
  }
  return { kind: "valid" };
}

function reservationAppend(digest: string, reservedAt: string, context: EventStoreContext) {
  return {
    streamId: `${RESERVATION_STREAM_PREFIX}${digest}`,
    wakeSourceContextName: "public-presence",
    expectedVersion: "no_stream" as const,
    context,
    events: [
      {
        eventType: "public-presence.waitlist-referral-code.reserved",
        payload: { codeDigest: digest, reservedAt },
      },
    ],
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isValidRecordedPayload(payload: StoredEvent["payload"]): boolean {
  return (
    hasOnlyKeys(
      payload,
      ["signupId", "email", "role", "interests", "emailConsentAcceptedAt", "marketingConsentAcceptedAt", "source"],
      ["referredBySignupId", "cohortQuality", "recordedAt"],
    ) &&
    typeof payload.signupId === "string" &&
    typeof payload.email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) &&
    (payload.role === "buy" || payload.role === "sell" || payload.role === "both") &&
    Array.isArray(payload.interests) &&
    payload.interests.length > 0 &&
    payload.interests.every((interest) => typeof interest === "string" && interest.length > 0) &&
    isUtcMillisecondInstant(payload.emailConsentAcceptedAt) &&
    (payload.marketingConsentAcceptedAt === null || isUtcMillisecondInstant(payload.marketingConsentAcceptedAt)) &&
    isValidSource(payload.source) &&
    (payload.referredBySignupId === undefined ||
      payload.referredBySignupId === null ||
      (typeof payload.referredBySignupId === "string" && /^wls_[0-9a-z]+$/.test(payload.referredBySignupId))) &&
    (payload.cohortQuality === undefined || isValidCohortQuality(payload.cohortQuality)) &&
    (payload.recordedAt === undefined || isUtcMillisecondInstant(payload.recordedAt))
  );
}

function isValidSignupEventPayload(event: StoredEvent, signupId: string): boolean {
  const payload = event.payload;
  switch (event.eventType) {
    case "public-presence.waitlist-signup.recorded":
      return isValidRecordedPayload(payload) && payload.signupId === signupId;
    case "public-presence.waitlist-signup.updated": {
      const { updatedAt, ...recordedShape } = payload;
      return (
        hasOnlyKeys(
          payload,
          [
            "signupId",
            "email",
            "role",
            "interests",
            "emailConsentAcceptedAt",
            "marketingConsentAcceptedAt",
            "source",
            "updatedAt",
          ],
          ["cohortQuality"],
        ) &&
        payload.signupId === signupId &&
        isValidRecordedPayload({ ...recordedShape, recordedAt: updatedAt }) &&
        isUtcMillisecondInstant(updatedAt)
      );
    }
    case "public-presence.waitlist-signup.cohort-quality-provided":
      return (
        hasExactKeys(payload, ["signupId", "cohortQuality", "providedAt"]) &&
        payload.signupId === signupId &&
        isValidCohortQuality(payload.cohortQuality) &&
        isUtcMillisecondInstant(payload.providedAt)
      );
    case "public-presence.waitlist-signup.admitted":
      return (
        hasExactKeys(payload, ["signupId", "email", "waveNumber", "invitationId", "admittedAt"]) &&
        payload.signupId === signupId &&
        typeof payload.email === "string" &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) &&
        (payload.waveNumber === 1 || payload.waveNumber === 2 || payload.waveNumber === 3) &&
        typeof payload.invitationId === "string" &&
        payload.invitationId.length > 0 &&
        isUtcMillisecondInstant(payload.admittedAt)
      );
    case "public-presence.waitlist-referral-code.issued":
      return payload.signupId === signupId && isValidIssuedPayload(payload);
    case "public-presence.waitlist-referral-link.provisioned":
      return (
        hasExactKeys(payload, [
          "signupId",
          "provisioningId",
          "tupleSha256",
          "referralLinkSha256",
          "performedByUserId",
          "issuedAt",
        ]) &&
        payload.signupId === signupId &&
        typeof payload.provisioningId === "string" &&
        /^wlp_[A-Za-z0-9_-]{22,}$/.test(payload.provisioningId) &&
        typeof payload.tupleSha256 === "string" &&
        /^[0-9a-f]{64}$/.test(payload.tupleSha256) &&
        typeof payload.referralLinkSha256 === "string" &&
        /^[0-9a-f]{64}$/.test(payload.referralLinkSha256) &&
        typeof payload.performedByUserId === "string" &&
        payload.performedByUserId.length > 0 &&
        isUtcMillisecondInstant(payload.issuedAt)
      );
    default:
      return false;
  }
}

function isValidSource(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return (
    hasExactKeys(source, ["pagePath", "referrer", "utmSource", "utmMedium", "utmCampaign", "utmContent", "utmTerm"]) &&
    typeof source.pagePath === "string" &&
    source.pagePath.length > 0 &&
    ["referrer", "utmSource", "utmMedium", "utmCampaign", "utmContent", "utmTerm"].every(
      (key) => source[key] === null || typeof source[key] === "string",
    )
  );
}

function isValidCohortQuality(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cohort = value as Record<string, unknown>;
  return (
    hasExactKeys(cohort, ["games", "hasStoreLink", "storeUrl", "inventorySize"]) &&
    Array.isArray(cohort.games) &&
    cohort.games.every((game) => typeof game === "string" && game.length > 0) &&
    typeof cohort.hasStoreLink === "boolean" &&
    (cohort.storeUrl === null || typeof cohort.storeUrl === "string") &&
    (cohort.inventorySize === null || typeof cohort.inventorySize === "string")
  );
}

function isValidIssuedPayload(payload: StoredEvent["payload"]): boolean {
  if (!hasExactKeys(payload, ["signupId", "publicReferralCode", "issuedAt"])) return false;
  const code = readString(payload.publicReferralCode);
  if (!code || !isUtcMillisecondInstant(payload.issuedAt)) return false;
  try {
    publicReferralCodeDigest(code);
    return true;
  } catch {
    return false;
  }
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasOnlyKeys(value: object, required: readonly string[], optional: readonly string[]): boolean {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => actual.includes(key)) && actual.every((key) => allowed.has(key));
}

function isUtcMillisecondInstant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isConcurrencyConflict(error: unknown): error is EventStoreError {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as EventStoreError).code === "concurrency_conflict",
  );
}
