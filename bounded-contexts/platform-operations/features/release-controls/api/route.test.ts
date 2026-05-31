import { createReleaseControlsPolicyRuntime } from "./runtime";
import { createReleaseControlsPolicyRoutes, type PlatformOperationsApiEnv } from "./route";
import type { AppendToStreamInput, ReadStreamInput, StoredEvent } from "@chase-sets/event-core/storage";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

function createInMemoryEventStore(): EventStore {
  const streams = new Map<string, StoredEvent[]>();

  return {
    appendToStream: async (input: AppendToStreamInput) => {
      const existing = streams.get(input.streamId) ?? [];
      const stored = input.events.map((event, index) => {
        const streamVersion = existing.length + index + 1;
        return {
          eventId: `evt_${streamVersion}` as StoredEvent["eventId"],
          streamId: input.streamId,
          streamVersion,
          globalPosition: String(streamVersion).padStart(20, "0") as StoredEvent["globalPosition"],
          tenantId: input.context.tenantId,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata ?? {},
          occurredAt: (event.occurredAt ?? "2026-05-31T12:00:00.000Z") as StoredEvent["occurredAt"],
          recordedAt: "2026-05-31T12:00:00.000Z" as StoredEvent["recordedAt"],
          performedByUserId: input.context.audit.performedByUserId,
          forAccountId: input.context.audit.forAccountId,
        };
      });
      streams.set(input.streamId, [...existing, ...stored]);
      return stored;
    },
    readStream: async (input: ReadStreamInput) => {
      const fromVersion = input.fromVersion ?? 1;
      return (streams.get(input.streamId) ?? []).filter((event) => event.streamVersion >= fromVersion);
    },
    readAll: async () => [...streams.values()].flat(),
  };
}

const actor = {
  sessionId: "ses_1",
  tenantId: "tnt_1",
  userId: "usr_ops",
  accountId: "acc_ops",
  membershipId: "mem_1",
  roleKey: "platform-admin",
  permissions: ["security.manage"],
};

function createApp() {
  const runtime = createReleaseControlsPolicyRuntime({
    eventStore: createInMemoryEventStore(),
    now: () => new Date("2026-05-31T12:00:00.000Z"),
  });
  const app = new Hono<PlatformOperationsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("context", {
      tenantId: "tnt_1",
      audit: { performedByUserId: "usr_ops", forAccountId: "acc_ops" },
    } as never);
    await next();
  });
  app.route("/", createReleaseControlsPolicyRoutes(runtime));
  return app;
}

describe("release controls policy API", () => {
  it("persists rollout policy changes and evaluates account canary decisions", async () => {
    const app = createApp();
    const update = await app.request("/rollouts/pricing.account-repricing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        environment: "production",
        percentage: 0,
        allowSubjects: ["account:acc_ops"],
        reason: "stage 2 canary",
        reference: "https://github.com/todd-skelton/chase-sets/pull/1",
      }),
    });

    expect(update.status).toBe(200);

    const decision = await app.request(
      "/rollouts/pricing.account-repricing/decision?environment=production&subjectType=account&subjectId=acc_ops",
    );

    expect(decision.status).toBe(200);
    await expect(decision.json()).resolves.toMatchObject({
      enabled: true,
      reason: "subject-allowlist",
      cohortSize: 1,
    });
  });

  it("requires a concrete reference before clearing a release lock", async () => {
    const app = createApp();
    await app.request("/release-lock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locked: true, reason: "incident", reference: "inc_1" }),
    });

    const response = await app.request("/release-lock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locked: false }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "Emergency release or release-lock clearance reference is required." },
    });
  });

  it("blocks cross-account rollout decision reads without platform permission", async () => {
    const runtime = createReleaseControlsPolicyRuntime({ eventStore: createInMemoryEventStore() });
    const app = new Hono<PlatformOperationsApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { ...actor, permissions: ["pricing.view"] });
      c.set("context", null);
      await next();
    });
    app.route("/", createReleaseControlsPolicyRoutes(runtime));

    const response = await app.request(
      "/rollouts/pricing.account-repricing/decision?environment=production&subjectType=account&subjectId=other",
    );

    expect(response.status).toBe(403);
  });
});
