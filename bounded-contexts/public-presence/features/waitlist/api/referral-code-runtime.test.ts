import { describe, expect, it, vi } from "vitest";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { createWaitlistRuntime } from "./runtime";
import { generatePublicReferralCode, publicReferralCodeDigest } from "../domain/public-referral-code";

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

// The exact events one first-time signup commits, in the order its atomic
// two-stream append writes them: the digest reservation, then the signup
// stream's recorded and issued pair.
const firstWriteEventTypes = [
  "public-presence.waitlist-referral-code.reserved",
  "public-presence.waitlist-signup.recorded",
  "public-presence.waitlist-referral-code.issued",
];

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
    const firstDigest = publicReferralCodeDigest(firstCode);
    await memory.eventStore.appendToStream({
      streamId: `public-presence.waitlist-referral-code-${firstDigest}`,
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "public-presence.waitlist-referral-code.reserved",
          payload: { codeDigest: firstDigest, reservedAt: "2026-08-01T00:00:00.000Z" },
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

  it("issue-6418-ac-4 joins creator X's code only with creator Y's requested tuple and rejects stale signup state", async () => {
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

  it("issue-6445-ac-1 records a first-time signup's committed events across both appended streams", async () => {
    const memory = createInMemoryEventStore();
    const services = runtime(memory.eventStore);

    const first = await runWithEventCommitMetadata(async () => {
      const result = await services.submitWaitlistSignup(signup("receipt@example.com"), context);
      return { result, metadata: getEventCommitMetadata() };
    });

    // Authority is the event store's own committed log, never a count derived
    // from the receipt under test. A losing attempt is spliced back out of it,
    // so it holds exactly the events this first write committed, in commit
    // order, and it is pinned here before any receipt surface is compared to it.
    const committed = [...memory.allEvents];
    const committedEventIds = committed.map((event) => String(event.eventId));
    expect(committed.map((event) => event.eventType)).toEqual(firstWriteEventTypes);
    expect(new Set(committedEventIds).size).toBe(committedEventIds.length);

    const issuedCode = memory.allEvents.find(
      (event) => event.eventType === "public-presence.waitlist-referral-code.issued",
    )?.payload.publicReferralCode as string;
    const firstSource = first.metadata.sources.find((entry) => entry.sourceContextName === "public-presence");
    // Never mere header/metadata presence: the decoded source, its context name
    // and a real maxGlobalPosition are all asserted.
    expect(firstSource).toBeDefined();
    expect(firstSource?.eventIds.length).toBeGreaterThan(0);
    expect(BigInt(firstSource?.maxGlobalPosition ?? "0")).toBeGreaterThan(0n);

    // Exact first-write authority: both receipt surfaces must carry every
    // committed id, once each, in commit order, with the exact reserved /
    // recorded / issued types and the exact committed horizon. Presence checks
    // and a set of covered stream ids cannot see partial or duplicate
    // recording -- one stream carries two of the three events, so keeping only
    // its first event still covers it, and a set collapses duplicates.
    expect(first.metadata.committedEvents.map((event) => String(event.eventId))).toEqual(committedEventIds);
    expect(firstSource?.eventIds).toEqual(committedEventIds);
    expect(new Set(firstSource?.eventIds ?? []).size).toBe(committedEventIds.length);
    expect(first.metadata.committedEvents.map((event) => event.eventType)).toEqual(firstWriteEventTypes);
    expect(firstSource?.maxGlobalPosition).toBe(committed.at(-1)?.globalPosition);

    const streamByEventId = new Map(
      first.metadata.committedEvents.map((event) => [String(event.eventId), event.streamId]),
    );
    expect(new Set(firstSource?.eventIds.map((eventId) => streamByEventId.get(eventId)))).toEqual(
      new Set([
        `public-presence.waitlist-referral-code-${publicReferralCodeDigest(issuedCode)}`,
        `public-presence.waitlist-signup-${first.result.signupId}`,
      ]),
    );

    // In-suite control: the repeat-signup branch commits through the command
    // handler, which has always recorded, and stays green on the same runtime in
    // the same run -- so a red first-write assertion isolates the bypassing path.
    const repeat = await runWithEventCommitMetadata(async () => {
      await services.submitWaitlistSignup(signup("receipt@example.com"), context);
      return getEventCommitMetadata();
    });
    const repeatSource = repeat.sources.find((entry) => entry.sourceContextName === "public-presence");
    expect(repeatSource?.eventIds.length).toBeGreaterThan(0);
    expect(BigInt(repeatSource?.maxGlobalPosition ?? "0")).toBeGreaterThan(
      BigInt(firstSource?.maxGlobalPosition ?? "0"),
    );
  });

  it("issue-6445-ac-2 records a first provisioning's committed events and records nothing on replay", async () => {
    const memory = createInMemoryEventStore();
    let entropy = 40;
    let tick = 0;
    const services = runtime(
      memory.eventStore,
      (length) => new Uint8Array(length).fill(entropy++),
      // Advancing clock and entropy: a replay that re-entered the write path
      // would mint a different provisioningId and issuedAt.
      () => new Date(Date.UTC(2026, 7, 2, 0, 0, tick++)),
    );
    const created = await services.submitWaitlistSignup(signup("provision-receipt@example.com"), context);
    const tuple = { utm_source: "creator" as const, utm_medium: "video", utm_campaign: "creator-y" };

    const firstProvisioning = await runWithEventCommitMetadata(async () => {
      const receipt = await services.provisionReferralLink({ signupId: created.signupId, tuple }, context);
      return { receipt, metadata: getEventCommitMetadata() };
    });
    const replay = await runWithEventCommitMetadata(async () => {
      const receipt = await services.provisionReferralLink({ signupId: created.signupId, tuple }, context);
      return { receipt, metadata: getEventCommitMetadata() };
    });

    // Control asserted first, so deleting only the provisioning recording call
    // leaves these green and reddens exactly the governing assertion below: the
    // idempotent replay appends nothing, records nothing, and still returns the
    // identical frozen receipt with its original provisioningId and issuedAt.
    expect(replay.metadata.sources).toEqual([]);
    expect(replay.metadata.committedEvents).toHaveLength(0);
    expect(replay.receipt).toEqual(firstProvisioning.receipt);
    expect(replay.receipt.payload.provisioningId).toBe(firstProvisioning.receipt.payload.provisioningId);
    expect(replay.receipt.payload.issuedAt).toBe(firstProvisioning.receipt.payload.issuedAt);
    expect(
      memory.allEvents.filter((event) => event.eventType === "public-presence.waitlist-referral-link.provisioned"),
    ).toHaveLength(1);

    const provisioningSource = firstProvisioning.metadata.sources.find(
      (entry) => entry.sourceContextName === "public-presence",
    );
    expect(provisioningSource?.eventIds).toHaveLength(1);
    expect(BigInt(provisioningSource?.maxGlobalPosition ?? "0")).toBeGreaterThan(0n);
    expect(firstProvisioning.metadata.committedEvents.map((event) => event.eventType)).toEqual([
      "public-presence.waitlist-referral-link.provisioned",
    ]);
    // Same exact authority as the first-time signup: the ids the store actually
    // committed for this provisioning, once each, on both receipt surfaces --
    // never the signup's earlier events and never a duplicate of its own.
    const committedProvisioning = memory.allEvents
      .filter((event) => event.eventType === "public-presence.waitlist-referral-link.provisioned")
      .map((event) => String(event.eventId));
    expect(committedProvisioning).toHaveLength(1);
    expect(firstProvisioning.metadata.committedEvents.map((event) => String(event.eventId))).toEqual(
      committedProvisioning,
    );
    expect(provisioningSource?.eventIds).toEqual(committedProvisioning);
    expect(provisioningSource?.maxGlobalPosition).toBe(
      memory.allEvents.find((event) => String(event.eventId) === committedProvisioning[0])?.globalPosition,
    );
  });
});
