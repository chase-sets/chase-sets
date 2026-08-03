import { describe, expect, it, vi } from "vitest";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { createWaitlistRuntime } from "./runtime";
import {
  generatePublicReferralCode,
  publicReferralCodeDigest,
  publicReferralCodeReservationStreamId,
} from "../domain/public-referral-code";

const context: EventStoreContext = {
  tenantId: "tnt_test" as TenantId,
  audit: { performedByUserId: "usr_operator" as UserId, forAccountId: "acc_test" as AccountId },
};
const source = {
  pagePath: "/",
  referrer: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmContent: null,
  utmTerm: null,
};

/**
 * The exact events one first-time signup commits, in the order its atomic
 * two-stream append writes them: the digest reservation, then the signup
 * stream's recorded and issued pair.
 */
const FIRST_WRITE_EVENT_TYPES = [
  "public-presence.waitlist-referral-code.reserved",
  "public-presence.waitlist-signup.recorded",
  "public-presence.waitlist-referral-code.issued",
] as const;

/**
 * One committed event rendered as `id:type`. Comparing these strings rather
 * than bare ids means a failing exact-sequence assertion names both the missing
 * committed id and the event type that went unrecorded.
 */
function identify(event: StoredEvent): string {
  return `${String(event.eventId)}:${event.eventType}`;
}

/**
 * Wraps an event store so every append's own resolved result is captured at the
 * production boundary. This is the authority the receipt is compared against:
 * `recordCommittedEvents` is handed exactly these arrays, so a partial hand-off
 * is visible here in a way a re-read of the store never could be -- the store
 * still holds the full committed set even when the recording call receives a
 * slice of it. Only resolved appends are captured, so a losing, rolled-back
 * attempt contributes nothing.
 */
function recordingEventStore(eventStore: EventStore) {
  const appended: StoredEvent[][] = [];
  const wrapped: EventStore = {
    ...eventStore,
    appendToStream: async (input) => {
      const storedEvents = await eventStore.appendToStream(input);
      appended.push([...storedEvents]);
      return storedEvents;
    },
    ...(eventStore.appendToStreams
      ? {
          appendToStreams: async (inputs) => {
            const results = await eventStore.appendToStreams!(inputs);
            appended.push(results.flatMap((result) => [...result.storedEvents]));
            return results;
          },
        }
      : {}),
  };
  return {
    eventStore: wrapped,
    /** The authoritative appends that resolved since `mark`, flattened in commit order. */
    committedSince(mark: number): readonly StoredEvent[] {
      return appended.slice(mark).flat();
    },
    appendCountSince(mark: number): number {
      return appended.length - mark;
    },
    get appendCount(): number {
      return appended.length;
    },
  };
}

function runtime(
  eventStore: EventStore,
  randomBytes = (length: number) => new Uint8Array(length).fill(3),
  now: () => Date = () => new Date("2026-08-02T00:00:00.000Z"),
) {
  return createWaitlistRuntime({
    eventStore,
    checkpointStore: {} as never,
    db: { query: vi.fn(async () => ({ rows: [] })) },
    policies: {} as never,
    now,
    randomBytes,
  });
}

function signup(email: string) {
  return {
    email,
    role: "both",
    interests: ["low-sales-fees"],
    source,
  };
}

describe("Public Referral Code runtime", () => {
  it("atomically records a new signup with one digest reservation and immutable issued code", async () => {
    const memory = createInMemoryEventStore();
    const services = runtime(memory.eventStore);
    const result = await services.submitWaitlistSignup(signup("creator@example.com"), context);
    expect(result.version).toBe(2);
    const recorded = memory.allEvents.filter((event) => event.eventType === "public-presence.waitlist-signup.recorded");
    const issued = memory.allEvents.filter(
      (event) => event.eventType === "public-presence.waitlist-referral-code.issued",
    );
    const reserved = memory.allEvents.filter(
      (event) => event.eventType === "public-presence.waitlist-referral-code.reserved",
    );
    expect([recorded.length, issued.length, reserved.length]).toEqual([1, 1, 1]);
    const publicReferralCode = issued[0].payload.publicReferralCode as string;
    expect(reserved[0].streamId).toBe(publicReferralCodeReservationStreamId(publicReferralCode));
    expect(reserved[0].streamId).toBe(
      `public-presence.waitlist-referral-code-${publicReferralCodeDigest(publicReferralCode)}`,
    );
    expect(JSON.stringify({ streamId: reserved[0].streamId, payload: reserved[0].payload })).not.toContain(
      publicReferralCode,
    );

    await services.submitWaitlistSignup(signup("creator@example.com"), context);
    expect(
      memory.allEvents.filter((event) => event.eventType === "public-presence.waitlist-referral-code.issued"),
    ).toHaveLength(1);
  });

  it("fails before any write when the imported optional multi-stream member is absent", async () => {
    const memory = createInMemoryEventStore();
    const withoutAtomicAppend = {
      appendToStream: memory.eventStore.appendToStream,
      readStream: memory.eventStore.readStream,
      readAll: memory.eventStore.readAll,
    } satisfies EventStore;
    await expect(
      runtime(withoutAtomicAppend).submitWaitlistSignup(signup("missing@example.com"), context),
    ).rejects.toThrow("requires EventStore.appendToStreams");
    expect(memory.allEvents).toHaveLength(0);
  });

  it("retries a no_stream digest collision without exposing or partially issuing the collided code", async () => {
    const memory = createInMemoryEventStore();
    const firstCode = generatePublicReferralCode((length) => new Uint8Array(length).fill(1));
    await memory.eventStore.appendToStream({
      streamId: publicReferralCodeReservationStreamId(firstCode),
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "public-presence.waitlist-referral-code.reserved",
          payload: { codeDigest: publicReferralCodeDigest(firstCode), reservedAt: "2026-08-01T00:00:00.000Z" },
        },
      ],
    });
    let calls = 0;
    const services = runtime(memory.eventStore, (length) => new Uint8Array(length).fill(++calls));
    await services.submitWaitlistSignup(signup("collision@example.com"), context);
    const issued = memory.allEvents.find(
      (event) => event.eventType === "public-presence.waitlist-referral-code.issued",
    );
    expect(issued?.payload.publicReferralCode).not.toBe(firstCode);
    expect(
      memory.allEvents.filter((event) => event.eventType === "public-presence.waitlist-signup.recorded"),
    ).toHaveLength(1);
    // The losing attempt rolled back whole: exactly one signup stream write and
    // exactly the pre-seeded reservation plus the winning one remain.
    expect(
      memory.allEvents.filter((event) => event.eventType === "public-presence.waitlist-referral-code.reserved"),
    ).toHaveLength(2);
  });

  it("settles concurrent first issue with one code and keeps same-tuple provisioning idempotent", async () => {
    const memory = createInMemoryEventStore();
    let entropy = 10;
    const services = runtime(memory.eventStore, (length) => new Uint8Array(length).fill(entropy++));
    await Promise.all([
      services.submitWaitlistSignup(signup("parallel@example.com"), context),
      services.submitWaitlistSignup(signup("parallel@example.com"), context),
    ]);
    expect(
      memory.allEvents.filter((event) => event.eventType === "public-presence.waitlist-referral-code.issued"),
    ).toHaveLength(1);
    expect(
      memory.allEvents.filter((event) => event.eventType === "public-presence.waitlist-referral-code.reserved"),
    ).toHaveLength(1);

    const tuple = { utm_source: "creator" as const, utm_medium: "video", utm_campaign: "creator-y" };
    const signupId = (memory.allEvents.find((event) => event.eventType === "public-presence.waitlist-signup.recorded")
      ?.payload.signupId ?? "") as string;
    const first = await services.provisionReferralLink({ signupId, tuple }, context);
    const retry = await services.provisionReferralLink({ signupId, tuple }, context);
    expect(retry).toEqual(first);
    expect([...new URL(first.payload.referralLink).searchParams.entries()]).toEqual([
      ["ref", first.payload.publicReferralCode],
      ["utm_source", "creator"],
      ["utm_medium", "video"],
      ["utm_campaign", "creator-y"],
    ]);
    expect(
      memory.allEvents.filter((event) => event.eventType === "public-presence.waitlist-referral-link.provisioned"),
    ).toHaveLength(1);
    expect(
      JSON.stringify(
        memory.allEvents.find((event) => event.eventType === "public-presence.waitlist-referral-link.provisioned")
          ?.payload,
      ),
    ).not.toContain("wlr_");
  });

  it("joins creator X's code only with creator Y's requested tuple and rejects stale signup state", async () => {
    const memory = createInMemoryEventStore();
    let entropy = 30;
    const services = runtime(memory.eventStore, (length) => new Uint8Array(length).fill(entropy++));
    const creatorX = await services.submitWaitlistSignup(signup("creator-x@example.com"), context);
    const creatorY = await services.submitWaitlistSignup(signup("creator-y@example.com"), context);
    const issuedBySignup = new Map(
      memory.allEvents
        .filter((event) => event.eventType === "public-presence.waitlist-referral-code.issued")
        .map((event) => [event.payload.signupId as string, event.payload.publicReferralCode as string]),
    );

    const receipt = await services.provisionReferralLink(
      {
        signupId: creatorX.signupId,
        tuple: { utm_source: "creator", utm_medium: "video", utm_campaign: "creator-y" },
      },
      context,
    );
    const parameters = new URL(receipt.payload.referralLink).searchParams;
    expect(parameters.get("ref")).toBe(issuedBySignup.get(creatorX.signupId));
    expect(parameters.get("ref")).not.toBe(issuedBySignup.get(creatorY.signupId));
    expect(parameters.get("utm_campaign")).toBe("creator-y");

    const beforeStaleRequest = memory.allEvents.length;
    await expect(
      services.provisionReferralLink(
        {
          signupId: "wls_stale",
          tuple: { utm_source: "creator", utm_medium: "video", utm_campaign: "creator-y" },
        },
        context,
      ),
    ).rejects.toThrow("does not have an issued Public Referral Code");
    expect(memory.allEvents).toHaveLength(beforeStaleRequest);
  });

  it("issue-6469-ac-1 records exactly the first-time signup's committed event id sequence, exactly once", async () => {
    const memory = createInMemoryEventStore();
    const recording = recordingEventStore(memory.eventStore);
    const services = runtime(recording.eventStore);

    const mark = recording.appendCount;
    const first = await runWithEventCommitMetadata(async () => {
      const result = await services.submitWaitlistSignup(signup("receipt@example.com"), context);
      return { result, metadata: getEventCommitMetadata() };
    });

    // AUTHORITY: the append result the production seam itself hands to
    // recordCommittedEvents -- not a re-read of the store, which would still
    // hold the full committed set under a partial hand-off, and not any count
    // derived from the receipt under test. Pinned before any receipt surface is
    // compared to it.
    expect(recording.appendCountSince(mark)).toBe(1);
    const authoritative = recording.committedSince(mark);
    const authoritativeIdentities = authoritative.map(identify);
    const authoritativeIds = authoritative.map((event) => String(event.eventId));
    expect(authoritative.map((event) => event.eventType)).toEqual([...FIRST_WRITE_EVENT_TYPES]);
    expect(new Set(authoritativeIds).size).toBe(authoritativeIds.length);

    const firstSource = first.metadata.sources.find((entry) => entry.sourceContextName === "public-presence");
    // Never mere presence: the decoded source must exist and name this context
    // before any of its contents are compared.
    expect(firstSource).toBeDefined();
    expect(firstSource?.sourceContextName).toBe("public-presence");

    // EXACTNESS, on both receipt surfaces. Soft assertions so one run reports
    // every violated property at once rather than only whichever fires first:
    // a sliced recording input must show as the missing `id:type` pairs, and a
    // duplicated one as wrong count AND lost uniqueness. Identity comparisons
    // come first so the failure text names the ids and types before the derived
    // horizon that also moves with them.
    const committedIdentities = first.metadata.committedEvents.map(identify);
    const sourceEventIds = [...(firstSource?.eventIds ?? [])];
    expect.soft(committedIdentities).toEqual(authoritativeIdentities);
    expect.soft(sourceEventIds).toEqual(authoritativeIds);
    expect.soft(committedIdentities).toHaveLength(authoritativeIdentities.length);
    expect.soft(sourceEventIds).toHaveLength(authoritativeIds.length);
    expect.soft(new Set(committedIdentities).size).toBe(committedIdentities.length);
    expect.soft(new Set(sourceEventIds).size).toBe(sourceEventIds.length);
    expect
      .soft(new Set(first.metadata.committedEvents.map((event) => event.eventType)))
      .toEqual(new Set(FIRST_WRITE_EVENT_TYPES));
    // The horizon is the exact committed maximum, not "greater than zero",
    // which any write in any context already satisfies.
    expect.soft(BigInt(firstSource?.maxGlobalPosition ?? "0")).toBeGreaterThan(0n);
    expect.soft(firstSource?.maxGlobalPosition).toBe(
      authoritative
        .map((event) => BigInt(event.globalPosition))
        .reduce((highest, position) => (position > highest ? position : highest), 0n)
        .toString(),
    );

    console.info(`issue-6469-ac-1 exact committed sequence: ${authoritativeIdentities.join(" | ")}`);

    const issuedCode = memory.allEvents.find(
      (event) => event.eventType === "public-presence.waitlist-referral-code.issued",
    )?.payload.publicReferralCode as string;
    const streamByEventId = new Map(
      first.metadata.committedEvents.map((event) => [String(event.eventId), event.streamId]),
    );
    expect(new Set(sourceEventIds.map((eventId) => streamByEventId.get(eventId)))).toEqual(
      new Set([
        publicReferralCodeReservationStreamId(issuedCode),
        `public-presence.waitlist-signup-${first.result.signupId}`,
      ]),
    );

    // IN-SUITE CONTROL (ac-4): the repeat-signup branch commits through the
    // command handler, which has always recorded. It reaches a non-empty,
    // decoded public-presence source with a real horizon in the same run -- and
    // therefore proves that satisfying "a receipt exists" is not satisfying the
    // first-write assertion above.
    const repeat = await runWithEventCommitMetadata(async () => {
      await services.submitWaitlistSignup(signup("receipt@example.com"), context);
      return getEventCommitMetadata();
    });
    const repeatSource = repeat.sources.find((entry) => entry.sourceContextName === "public-presence");
    expect(repeatSource?.sourceContextName).toBe("public-presence");
    expect(repeatSource?.eventIds.length).toBeGreaterThan(0);
    expect(BigInt(repeatSource?.maxGlobalPosition ?? "0")).toBeGreaterThan(
      BigInt(firstSource?.maxGlobalPosition ?? "0"),
    );
  });

  it("issue-6469-ac-3 records exactly one provisioning event and records nothing on replay", async () => {
    const memory = createInMemoryEventStore();
    const recording = recordingEventStore(memory.eventStore);
    let entropy = 40;
    let tick = 0;
    const services = runtime(
      recording.eventStore,
      (length) => new Uint8Array(length).fill(entropy++),
      // Advancing clock and entropy: a replay that re-entered the write path
      // would mint a different provisioningId and issuedAt.
      () => new Date(Date.UTC(2026, 7, 2, 0, 0, tick++)),
    );
    const created = await services.submitWaitlistSignup(signup("provision-receipt@example.com"), context);
    const tuple = { utm_source: "creator" as const, utm_medium: "video", utm_campaign: "creator-y" };

    const provisioningMark = recording.appendCount;
    const firstProvisioning = await runWithEventCommitMetadata(async () => {
      const receipt = await services.provisionReferralLink({ signupId: created.signupId, tuple }, context);
      return { receipt, metadata: getEventCommitMetadata() };
    });
    const replayMark = recording.appendCount;
    const replay = await runWithEventCommitMetadata(async () => {
      const receipt = await services.provisionReferralLink({ signupId: created.signupId, tuple }, context);
      return { receipt, metadata: getEventCommitMetadata() };
    });

    // Control asserted first, so a negative control that deletes only the
    // provisioning recording call leaves these green and reddens exactly the
    // governing assertions below: the idempotent replay appends nothing,
    // records nothing, and still returns the identical frozen receipt with its
    // original provisioningId and issuedAt.
    expect(recording.appendCountSince(replayMark)).toBe(0);
    expect(replay.metadata.sources).toEqual([]);
    expect(replay.metadata.committedEvents).toHaveLength(0);
    expect(replay.receipt).toEqual(firstProvisioning.receipt);
    expect(replay.receipt.payload.provisioningId).toBe(firstProvisioning.receipt.payload.provisioningId);
    expect(replay.receipt.payload.issuedAt).toBe(firstProvisioning.receipt.payload.issuedAt);
    expect(
      memory.allEvents.filter((event) => event.eventType === "public-presence.waitlist-referral-link.provisioned"),
    ).toHaveLength(1);

    // Same exact authority as the first-time signup: the ids this provisioning
    // append actually committed, once each, on both receipt surfaces -- never
    // the signup's earlier events and never a duplicate of its own.
    expect(recording.appendCountSince(provisioningMark)).toBe(1);
    const authoritative = recording.committedSince(provisioningMark);
    expect(authoritative).toHaveLength(1);
    const authoritativeIdentities = authoritative.map(identify);
    expect(authoritative.map((event) => event.eventType)).toEqual([
      "public-presence.waitlist-referral-link.provisioned",
    ]);

    const provisioningSource = firstProvisioning.metadata.sources.find(
      (entry) => entry.sourceContextName === "public-presence",
    );
    expect.soft(firstProvisioning.metadata.committedEvents.map(identify)).toEqual(authoritativeIdentities);
    expect.soft(provisioningSource?.eventIds).toEqual(authoritative.map((event) => String(event.eventId)));
    expect.soft(provisioningSource?.eventIds).toHaveLength(1);
    expect.soft(new Set(provisioningSource?.eventIds ?? []).size).toBe(1);
    expect.soft(provisioningSource?.sourceContextName).toBe("public-presence");
    expect.soft(provisioningSource?.maxGlobalPosition).toBe(String(authoritative[0].globalPosition));

    console.info(`issue-6469-ac-3 exact committed sequence: ${authoritativeIdentities.join(" | ")}`);
  });
});
