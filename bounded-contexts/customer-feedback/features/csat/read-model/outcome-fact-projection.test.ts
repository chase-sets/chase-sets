import { describe, expect, it, vi } from "vitest";
import { buildCsatOutcomeFactProjectionHandlers } from "./outcome-fact-projection";

function event(type: string, data: Record<string, unknown>) {
  return {
    id: "evt_1",
    type,
    streamId: "source-1",
    streamVersion: 1,
    globalPosition: "1" as never,
    tenantId: "tnt_test" as never,
    data,
    metadata: {},
    audit: { performedByUserId: "usr_1" as never, forAccountId: "acc_1" as never },
    trace: {},
    timing: { occurredAt: "2026-01-01T00:00:00.000Z" as never, recordedAt: "2026-01-01T00:00:01.000Z" as never },
  };
}

describe("CSAT outcome fact projection", () => {
  it("projects typed Auth source values and upserts on replay", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const calls = query.mock.calls as unknown as Array<[unknown, unknown]>;
    const handler = buildCsatOutcomeFactProjectionHandlers()["auth.session.started"]!;
    const source = event("auth.session.started", {
      sessionId: "ses_1",
      userId: "usr_1",
      accountId: "acc_1",
      availableAccountIds: ["acc_1"],
      authenticationMethod: "password",
      expiresAt: "2026-01-02T00:00:00.000Z",
    });
    await handler(source as never, { db: { query } });
    await handler(source as never, { db: { query } });
    expect(query).toHaveBeenCalledTimes(2);
    expect(calls[0]?.[1]).toEqual([
      "auth:authentication:ses_1",
      "authentication.completed",
      "auth",
      "acc_1",
      "account",
      "session",
      "ses_1",
      "2026-01-01T00:00:01.000Z",
      "evt_1",
      "usr_1",
      "password",
      null,
    ]);
  });

  it("keeps legacy missing authentication method nullable", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const calls = query.mock.calls as unknown as Array<[unknown, unknown]>;
    const handler = buildCsatOutcomeFactProjectionHandlers()["identity.registration.completed"]!;
    await handler(event("identity.registration.completed", { accountId: "acc_1", userId: "usr_1" }) as never, {
      db: { query },
    });
    const values = calls[0]?.[1] as unknown[] | undefined;
    expect(values?.[10]).toBeNull();
  });
});
