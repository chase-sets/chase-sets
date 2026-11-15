import { describe, expect, it } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { outcomeHandlers, outcomeRows } from "../../../tests/outcome-fact-test-support";

const timing = { occurredAt: "2026-01-01T00:00:00.000Z", recordedAt: "2026-01-01T00:00:01.000Z" };
const audit = { performedByUserId: "usr_bootstrap", forAccountId: "acc_bootstrap" };
const auth = buildTransportEvent(
  "auth.session.started",
  {
    sessionId: "ses_1" as never,
    userId: "usr_customer" as never,
    accountId: "acc_1" as never,
    availableAccountIds: ["acc_1"],
    authenticationMethod: "password",
    expiresAt: "2026-01-02T00:00:00.000Z",
  },
  { id: "evt_auth_1", timing, audit },
);

const fixtures = [
  {
    name: "auth.session.started",
    event: auth,
    row: [
      "auth:authentication:ses_1",
      "authentication.completed",
      "auth",
      "acc_1",
      "account",
      "session",
      "ses_1",
      timing.recordedAt,
      "evt_auth_1",
      "usr_bootstrap",
      "password",
      null,
    ],
  },
  {
    name: "identity.registration.completed",
    event: buildTransportEvent(
      "identity.registration.completed",
      { accountId: "acc_1" as never, userId: "usr_customer" as never },
      { id: "evt_registration", timing, audit },
    ),
    row: [
      "identity:registration:acc_1",
      "registration.completed",
      "identity",
      "acc_1",
      "account",
      "account",
      "acc_1",
      timing.recordedAt,
      "evt_registration",
      "usr_bootstrap",
      null,
      null,
    ],
  },
  {
    name: "identity.onboarding.completed guest-account",
    event: buildTransportEvent(
      "identity.onboarding.completed",
      { accountId: "acc_1" as never, userId: "usr_customer" as never, onboardingPath: "guest-account" },
      { id: "evt_guest", timing, audit },
    ),
    row: [
      "identity:onboarding:guest-account:acc_1:usr_customer",
      "onboarding.completed",
      "identity",
      "acc_1",
      "account",
      "account",
      "acc_1",
      timing.recordedAt,
      "evt_guest",
      "usr_bootstrap",
      null,
      null,
    ],
  },
  {
    name: "identity.onboarding.completed invitation",
    event: buildTransportEvent(
      "identity.onboarding.completed",
      {
        accountId: "acc_1" as never,
        userId: "usr_customer" as never,
        onboardingPath: "invitation",
        invitationId: "ivt_1",
      },
      { id: "evt_invitation", timing, audit },
    ),
    row: [
      "identity:onboarding:invitation:ivt_1:usr_customer",
      "onboarding.completed",
      "identity",
      "acc_1",
      "account",
      "invitation",
      "ivt_1",
      timing.recordedAt,
      "evt_invitation",
      "usr_bootstrap",
      null,
      null,
    ],
  },
  {
    name: "discovery.search-session.started",
    event: buildTransportEvent(
      "discovery.search-session.started",
      { accountId: "acc_1" as never, sessionId: "ses_1" as never },
      { id: "evt_search", timing, audit },
    ),
    row: [
      "discovery:search-session:ses_1",
      "discovery.search-completed",
      "discovery",
      "acc_1",
      "account",
      "session",
      "ses_1",
      timing.recordedAt,
      "evt_search",
      "usr_bootstrap",
      null,
      null,
    ],
  },
];

describe("CSAT outcome fact projection", () => {
  it.each(fixtures)("projects $name with helper-parity row", async ({ event, row }) => {
    const store = outcomeRows();
    await outcomeHandlers[event.type]!(event, store);
    expect(store.rows.get(String(row[0]))).toEqual(row);
    expect(store.db.query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (idempotency_key) DO NOTHING"),
      row,
    );
  });

  it("replay upserts one row per idempotency key", async () => {
    const store = outcomeRows();
    for (const { event } of fixtures) {
      const handler = outcomeHandlers[event.type]!;
      await handler(event, store);
      await handler(event, store);
    }
    expect(store.rows.size).toBe(fixtures.length);
    expect([...store.rows.values()]).toEqual(fixtures.map(({ row }) => row));
    expect(store.db.query).toHaveBeenCalledTimes(fixtures.length * 2);
  });

  it("projects raw source columns", async () => {
    const store = outcomeRows();
    // Explicitly synthetic missing-field history, not a valid typed Auth payload.
    const legacy = buildTransportEvent(
      "auth.session.started",
      {
        sessionId: "ses_synthetic_legacy",
        userId: "usr_legacy",
        accountId: "acc_legacy",
      } as never,
      { id: "evt_synthetic_legacy", timing, audit },
    );
    for (const event of [auth, legacy]) {
      await outcomeHandlers[event.type]!(event, store);
      await outcomeHandlers[event.type]!(event, store);
    }
    expect(store.rows.size).toBe(2);
    expect(store.rows.get("auth:authentication:ses_1")!.slice(7)).toEqual([
      timing.recordedAt,
      "evt_auth_1",
      "usr_bootstrap",
      "password",
      null,
    ]);
    expect(store.rows.get("auth:authentication:ses_synthetic_legacy")!.slice(7)).toEqual([
      timing.recordedAt,
      "evt_synthetic_legacy",
      "usr_bootstrap",
      null,
      null,
    ]);
  });
});
