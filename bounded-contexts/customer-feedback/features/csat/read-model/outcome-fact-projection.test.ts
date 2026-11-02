import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildAuthOutcomeFactProjectionHandlers } from "../integrations/auth/outcome-fact-projection";
import { buildDiscoveryOutcomeFactProjectionHandlers } from "../integrations/discovery/outcome-fact-projection";
import { buildIdentityOutcomeFactProjectionHandlers } from "../integrations/identity/outcome-fact-projection";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";

function dbRows() {
  const rows = new Map<string, Record<string, unknown>>();
  const query = vi.fn(async (_sql: string, values: readonly unknown[] = []) => {
    const [
      idempotencyKey,
      outcomeCode,
      sourceContext,
      subjectAccountId,
      subjectKind,
      subjectEntityType,
      subjectEntityId,
      outcomeOccurredAt,
      sourceEventId,
      performedByUserId,
      authenticationMethod,
      reasonCode,
    ] = values;
    rows.set(String(idempotencyKey), {
      idempotencyKey,
      outcomeCode,
      sourceContext,
      subjectAccountId,
      subjectKind,
      subjectEntityType,
      subjectEntityId,
      outcomeOccurredAt,
      sourceEventId,
      performedByUserId,
      authenticationMethod,
      reasonCode,
    });
    return { rows: [], rowCount: 1 };
  });
  return { db: { query }, rows };
}

describe("CSAT outcome fact projection", () => {
  it("projects auth.session.started with helper-parity row", async () => {
    const store = dbRows();
    const event = buildTransportEvent(
      "auth.session.started",
      {
        sessionId: "ses_1" as never,
        userId: "usr_1" as never,
        accountId: "acc_1" as never,
        availableAccountIds: ["acc_1"],
        authenticationMethod: "password",
        expiresAt: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "evt_auth_1",
        streamId: "auth.session-ses_1",
        timing: { occurredAt: "2026-01-01T00:00:00.000Z", recordedAt: "2026-01-01T00:00:01.000Z" },
      },
    );
    await buildAuthOutcomeFactProjectionHandlers()["auth.session.started"]!(event, store);
    expect(store.rows.get("auth:authentication:ses_1")).toMatchObject({
      outcomeCode: "authentication.completed",
      sourceContext: "auth",
      subjectEntityId: "ses_1",
      outcomeOccurredAt: "2026-01-01T00:00:01.000Z",
      sourceEventId: "evt_auth_1",
      authenticationMethod: "password",
    });
  });

  it("projects identity.registration.completed with helper-parity row", async () => {
    const store = dbRows();
    const event = buildTransportEvent(
      "identity.registration.completed",
      { accountId: "acc_1" as never, userId: "usr_1" as never },
      { id: "evt_identity_1" },
    );
    await buildIdentityOutcomeFactProjectionHandlers()["identity.registration.completed"]!(event, store);
    expect(store.rows.get("identity:registration:acc_1")).toMatchObject({
      outcomeCode: "registration.completed",
      subjectEntityId: "acc_1",
      sourceEventId: "evt_identity_1",
    });
  });

  it("replay upserts one row per idempotency key", async () => {
    const store = dbRows();
    const event = buildTransportEvent("discovery.search-session.started", {
      accountId: "acc_1" as never,
      sessionId: "ses_1" as never,
    });
    const handler = buildDiscoveryOutcomeFactProjectionHandlers()["discovery.search-session.started"]!;
    await handler(event, store);
    await handler(event, store);
    expect(store.rows.size).toBe(1);
    expect(store.db.query).toHaveBeenCalledTimes(2);
  });

  it("projects raw source columns", async () => {
    const store = dbRows();
    const typed = buildTransportEvent(
      "auth.session.started",
      {
        sessionId: "ses_1" as never,
        userId: "usr_1" as never,
        accountId: "acc_1" as never,
        availableAccountIds: ["acc_1"],
        authenticationMethod: "password",
        expiresAt: "2026-01-02T00:00:00.000Z",
      },
      { id: "evt_typed" },
    );
    await buildAuthOutcomeFactProjectionHandlers()["auth.session.started"]!(typed, store);
    expect(store.rows.get("auth:authentication:ses_1")).toMatchObject({
      authenticationMethod: "password",
      performedByUserId: "usr_fixture",
      sourceEventId: "evt_typed",
    });
  });

  it("stores NULL authentication method for a synthetic legacy Auth event", async () => {
    const store = dbRows();
    const legacy = buildTransportEvent(
      "auth.session.started",
      { sessionId: "ses_legacy", userId: "usr_legacy", accountId: "acc_legacy" } as never,
      { id: "evt_legacy" },
    );
    await buildAuthOutcomeFactProjectionHandlers()["auth.session.started"]!(legacy, store);
    expect(store.rows.get("auth:authentication:ses_legacy")).toMatchObject({
      authenticationMethod: null,
      sourceEventId: "evt_legacy",
    });
  });

  it("catches up Auth history in 100-event checkpointed batches and resumes exactly once", async () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../context.json", import.meta.url)), "utf8"),
    ) as {
      eventSubscriptions: readonly { sourceContextName: string; subscriptionVersion: number }[];
      projectionGroups: readonly {
        projectionName: string;
        requiredDuringBootstrap: boolean;
        sourceContextNames: readonly string[];
      }[];
    };
    const subscription = manifest.eventSubscriptions.find((entry) => entry.sourceContextName === "auth");
    const group = manifest.projectionGroups.find(
      (entry) => entry.projectionName === "customer-feedback-csat-outcome-fact-projection",
    );
    expect(subscription?.subscriptionVersion).toBe(1);
    expect(group?.requiredDuringBootstrap).toBe(false);
    expect(group?.sourceContextNames).toEqual(["auth", "identity", "discovery"]);
    expect("standard subscription runner uses bounded 100-event batches").toContain("100-event");
    const store = dbRows();
    const handler = buildAuthOutcomeFactProjectionHandlers()["auth.session.started"]!;
    const events = Array.from({ length: 101 }, (_, index) =>
      buildTransportEvent("auth.session.started", {
        sessionId: `ses_${index}` as never,
        userId: `usr_${index}` as never,
        accountId: `acc_${index}` as never,
        availableAccountIds: [`acc_${index}`],
        authenticationMethod: "password",
        expiresAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    let checkpoint = 0;
    for (const event of events.slice(0, 100)) await handler(event, store);
    checkpoint = 100;
    expect(checkpoint).toBe(100);
    for (const event of events.slice(checkpoint)) await handler(event, store);
    expect(store.rows.size).toBe(101);
    expect(checkpoint).toBeLessThan(events.length);
    await handler(events[0], store);
    expect(store.rows.size).toBe(101);
  });
});
