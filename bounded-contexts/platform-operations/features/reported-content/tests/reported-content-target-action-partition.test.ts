import { Hono } from "hono";
import type { AuthenticatedApiEnv, ResolvedActor } from "@chase-sets/auth-context";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import { describe, expect, it, vi } from "vitest";
import {
  REPORTED_CONTENT_ACTIONS_BY_TARGET_TYPE,
  REPORTED_CONTENT_STATUS_BY_ACTION,
  REPORTED_CONTENT_TARGET_TYPES,
  reportedContentActionRejectionCodes,
} from "../api/contracts";
import { createReportedContentRoutes } from "../api/http";
import { createReportedContentRuntime } from "../api/runtime";

const marker = "PLANTED_REQUEST_MARKER_10301";
const actor = Object.freeze({
  sessionId: "ses_partition",
  tenantId: "tnt_partition",
  userId: createId("usr"),
  accountId: createId("acc"),
  membershipId: "mbr_partition",
  roleKey: "platform-admin",
  permissions: Object.freeze(["reported-content.view"]),
}) satisfies ResolvedActor;
const context = Object.freeze({
  tenantId: "tnt_partition",
  audit: Object.freeze({ performedByUserId: actor.userId, forAccountId: actor.accountId }),
}) as EventStoreContext;
const notes = new Set<string>([
  "withdraw-review",
  "redact-review-feedback",
  "withdraw-review-reply",
  "redact-profile-display-name",
]);

function harness({ queued = true }: Readonly<{ queued?: boolean }> = {}) {
  const appendToStream = vi.fn().mockResolvedValue([]);
  const db = { query: vi.fn().mockResolvedValue({ rows: queued ? [{}] : [] }) } as unknown as PgQueryable;
  const services = createReportedContentRuntime({ db, eventStore: { appendToStream } as unknown as EventStore });
  const app = new Hono<AuthenticatedApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("context", context);
    await next();
  });
  app.route("/", createReportedContentRoutes(services));
  return {
    appendToStream,
    post: (targetType: string, targetId: string, body: string) =>
      app.request(`/${encodeURIComponent(targetType)}/${encodeURIComponent(targetId)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
  };
}

function targetIdFor(targetType: string) {
  return createId(
    ({ listing: "lst", review: "rev", "account-profile": "acc" } as Record<string, string>)[targetType] ?? "x",
  );
}

async function expectRejected(response: Response, reason: string) {
  const text = await response.text();
  expect(response.status).toBe(400);
  expect(JSON.parse(text)).toEqual({
    error: { code: "validation_failed", reason, message: "The reported content action was rejected." },
  });
  expect(text).not.toContain(marker);
}

describe("reported-content-target-action-partition", () => {
  const targets = [...REPORTED_CONTENT_TARGET_TYPES, "saved-list", "unknown-target"];
  const actions = [...Object.keys(REPORTED_CONTENT_STATUS_BY_ACTION), "reopen", "unknown-action"];

  it("target x action: each target accepts exactly its actions; everything else fails before append", async () => {
    const accepted: string[] = [];
    for (const targetType of targets) {
      for (const action of actions) {
        const { appendToStream, post } = harness();
        const response = await post(targetType, targetIdFor(targetType), JSON.stringify({ action, note: marker }));
        const allowed = (
          (REPORTED_CONTENT_ACTIONS_BY_TARGET_TYPE as Record<string, readonly string[]>)[targetType] ?? []
        ).includes(action);
        if (allowed) {
          expect(response.status, `${targetType} x ${action}`).toBe(200);
          expect(appendToStream).toHaveBeenCalledTimes(1);
          expect(appendToStream.mock.calls[0]![0].events[0].payload).toMatchObject({ targetType, action });
          accepted.push(`${targetType}:${action}`);
          continue;
        }
        const reason = !(action in REPORTED_CONTENT_STATUS_BY_ACTION)
          ? "unknown-action"
          : !REPORTED_CONTENT_TARGET_TYPES.includes(targetType as never)
            ? "unknown-target-type"
            : "action-not-allowed";
        await expectRejected(response, reason);
        expect(appendToStream, `${targetType} x ${action}`).not.toHaveBeenCalled();
      }
    }
    expect(accepted).toEqual(
      Object.entries(REPORTED_CONTENT_ACTIONS_BY_TARGET_TYPE).flatMap(([targetType, targetActions]) =>
        targetActions.map((action) => `${targetType}:${action}`),
      ),
    );
  });

  it("note-requiring actions fail without a nonblank note; other actions accept none", async () => {
    for (const targetType of REPORTED_CONTENT_TARGET_TYPES) {
      for (const action of REPORTED_CONTENT_ACTIONS_BY_TARGET_TYPE[targetType]) {
        for (const body of [{ action }, { action, note: null }, { action, note: "   " }]) {
          const { appendToStream, post } = harness();
          const response = await post(targetType, targetIdFor(targetType), JSON.stringify(body));
          if (notes.has(action)) {
            await expectRejected(response, "note-required");
            expect(appendToStream).not.toHaveBeenCalled();
          } else {
            expect(response.status).toBe(200);
            expect(appendToStream.mock.calls[0]![0].events[0].payload.note).toBeNull();
          }
        }
      }
    }
  });

  it.each([
    ["unknown field", JSON.stringify({ action: "dismiss", [marker]: true }), "invalid-request"],
    ["prototype key", `{"__proto__":{"${marker}":true},"action":"dismiss"}`, "invalid-request"],
    ["array body", JSON.stringify([{ action: "dismiss" }]), "invalid-request"],
    ["malformed JSON", `{"action":"${marker}`, "invalid-request"],
    ["non-string action", JSON.stringify({ action: { nested: marker } }), "invalid-request"],
    ["non-string note", JSON.stringify({ action: "dismiss", note: [marker] }), "invalid-request"],
    ["unknown action text", JSON.stringify({ action: marker }), "unknown-action"],
  ])("rejects a body with %s before append", async (_name, body, reason) => {
    const { appendToStream, post } = harness();
    await expectRejected(await post("listing", targetIdFor("listing"), body), reason);
    expect(appendToStream).not.toHaveBeenCalled();
  });

  it("rejects an unqueued target, a malformed Account Profile target and an invalid directive before append", async () => {
    for (const targetType of REPORTED_CONTENT_TARGET_TYPES) {
      const { appendToStream, post } = harness({ queued: false });
      await expectRejected(
        await post(targetType, targetIdFor(targetType), JSON.stringify({ action: "dismiss", note: marker })),
        "target-not-queued",
      );
      expect(appendToStream).not.toHaveBeenCalled();
    }
    const profile = harness();
    await expectRejected(
      await profile.post("account-profile", `acc_${marker}`, JSON.stringify({ action: "dismiss" })),
      "invalid-target-id",
    );
    const listing = harness();
    await expectRejected(
      await listing.post("listing", `lst_${marker}`, JSON.stringify({ action: "unlist" })),
      "invalid-listing-removal-directive",
    );
    expect(profile.appendToStream).not.toHaveBeenCalled();
    expect(listing.appendToStream).not.toHaveBeenCalled();
  });

  it("publishes only bounded rejection codes", () => {
    expect(reportedContentActionRejectionCodes).toEqual([
      "invalid-request",
      "unknown-target-type",
      "invalid-target-id",
      "unknown-action",
      "action-not-allowed",
      "note-required",
      "target-not-queued",
      "invalid-listing-removal-directive",
    ]);
  });
});
