import { describe, expect, it, vi } from "vitest";
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

function runtime(eventStore: EventStore, randomBytes = (length: number) => new Uint8Array(length).fill(3)) {
  return createWaitlistRuntime({
    eventStore,
    checkpointStore: {} as never,
    db: { query: vi.fn(async () => ({ rows: [] })) },
    policies: {} as never,
    now: () => new Date("2026-08-02T00:00:00.000Z"),
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
});
