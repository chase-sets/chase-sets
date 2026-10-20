import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { t } from "@chase-sets/localization";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION, type GlobalPosition } from "@chase-sets/event-core/storage";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { ReputationApiEnv } from "./http";
import { createAccountReviewRoutes } from "./route";
import { createReviewRuntime } from "./runtime";
import { authoredTextRecoveryMessage } from "../ui/authored-text-recovery";

const SECRET_MARKER = "SECRET-MARKER-7281";
const RATE_LIMIT_MAX_ENV = "CHASE_SETS_RATE_LIMIT_MARKETPLACE_REVIEW_AUTHORING_MAX";

function checkpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();
  return {
    loadCheckpoint: async (name) => checkpoints.get(name) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (name, checkpoint) => {
      checkpoints.set(name, checkpoint);
    },
  };
}

function actor(accountId: string): NonNullable<ReputationApiEnv["Variables"]["actor"]> {
  return {
    sessionId: `ses_${accountId}`,
    tenantId: "tnt_identity",
    userId: `usr_${accountId}`,
    accountId,
    membershipId: `mbr_${accountId}`,
    roleKey: "owner",
    permissions: ["reputation.view", "reputation.manage"],
  } as NonNullable<ReputationApiEnv["Variables"]["actor"]>;
}

function createFixture() {
  const reviews = new Map<string, { review_id: string; author_account_id: string }>();
  const db = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("FROM marketplace_review_eligibility_pages") && sql.includes("author_account_id = $2")) {
        return {
          rows: [
            {
              order_id: "ord_1",
              author_account_id: "acc_buyer",
              subject_account_id: "acc_seller",
              author_role: "buyer",
              eligible_at: new Date().toISOString(),
            },
          ],
        };
      }
      if (sql.includes("WHERE page.review_id = $1")) {
        const review = reviews.get(String(params?.[0]));
        return {
          rows: review
            ? [{ ...review, order_id: "ord_1", author_role: "buyer", status: "active", revealed_at: null, held: false }]
            : [],
        };
      }
      return { rows: [] };
    }),
  };
  const { allEvents, eventStore } = createInMemoryEventStore();
  const runtime = createReviewRuntime({ eventStore, checkpointStore: checkpointStore(), db: db as never });
  const app = new Hono<ReputationApiEnv>();
  let current = actor("acc_buyer");
  app.use("*", async (c, next) => {
    c.set("actor", current);
    c.set("context", {
      tenantId: "tnt_identity" as never,
      audit: { performedByUserId: current.userId as never, forAccountId: current.accountId as never },
    });
    await next();
  });
  app.route("/reviews", createAccountReviewRoutes(runtime));

  return {
    allEvents,
    runtime,
    actAs(accountId: string) {
      current = actor(accountId);
    },
    rememberReview(reviewId: string) {
      reviews.set(reviewId, { review_id: reviewId, author_account_id: "acc_buyer" });
    },
    post(path: string, body: unknown) {
      return app.request(`/reviews${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  };
}

async function errorBody(response: Response) {
  return (await response.json()) as { error: { code: string; message: string } };
}

const rejectedFeedback: readonly (readonly [string, string])[] = [
  [`${SECRET_MARKER} \u0000`, "text_control_character"],
  [`${SECRET_MARKER} ‮evil`, "text_direction_override"],
  [`${SECRET_MARKER} javascript:alert(1)`, "text_unsafe_link"],
  [`${SECRET_MARKER} https://spam.example https://spam.example`, "text_duplicate_link"],
];

afterEach(() => {
  delete process.env[RATE_LIMIT_MAX_ENV];
});

describe("issue-5258-marketplace-ac2 Review HTTP route safeguard", () => {
  it.each(rejectedFeedback)("rejects Review Feedback %#, appending no event", async (feedback, code) => {
    const fixture = createFixture();

    const response = await fixture.post("", { orderId: "ord_1", subjectAccountId: "acc_seller", rating: 5, feedback });
    const body = await errorBody(response);

    expect(response.status).toBe(400);
    expect(body.error).toEqual({ code, message: authoredTextRecoveryMessage(code) });
    expect(JSON.stringify(body)).not.toContain(SECRET_MARKER);
    expect(fixture.allEvents).toHaveLength(0);
  });

  it("accepts ordinary Unicode and https feedback with exactly the submitted and outcome events", async () => {
    const fixture = createFixture();

    const response = await fixture.post("", {
      orderId: "ord_1",
      subjectAccountId: "acc_seller",
      rating: 5,
      feedback: "Envío rápido 🚀 — photos at https://example.com/cards/1",
    });

    expect(response.status).toBe(201);
    expect(fixture.allEvents.map((event) => event.eventType)).toEqual([
      "marketplace.review.submitted",
      "marketplace.csat-outcome-fact.v1",
    ]);
  });

  it("rejects an unsafe update and an unsafe Review Response without appending", async () => {
    const fixture = createFixture();
    const submitted = (await (
      await fixture.post("", { orderId: "ord_1", subjectAccountId: "acc_seller", rating: 4, feedback: "Good." })
    ).json()) as { id: string };
    fixture.rememberReview(submitted.id);

    const update = await fixture.post(`/${submitted.id}/update`, { rating: 3, feedback: "See http://x.example" });
    expect(update.status).toBe(400);
    expect((await errorBody(update)).error.code).toBe("text_unsafe_link");
    expect(fixture.allEvents).toHaveLength(2);

    await fixture.runtime.commandHandler({
      streamId: `marketplace.review-${submitted.id}`,
      command: { type: "RevealReview", revealedAt: new Date().toISOString(), reason: "window-expired" },
      context: {
        tenantId: "tnt_identity" as never,
        audit: { performedByUserId: "usr_x" as never, forAccountId: "acc_buyer" as never },
      },
    });
    fixture.actAs("acc_seller");
    const reply = await fixture.post(`/${submitted.id}/reply`, { feedback: "Thanks ⁦hidden⁩" });
    expect(reply.status).toBe(400);
    expect((await errorBody(reply)).error).toEqual({
      code: "text_direction_override",
      message: authoredTextRecoveryMessage("text_direction_override"),
    });
    expect(fixture.allEvents).toHaveLength(3);

    const accepted = await fixture.post(`/${submitted.id}/reply`, { feedback: "Thanks for the order!" });
    expect(accepted.status).toBe(201);
    expect(fixture.allEvents.at(-1)?.eventType).toBe("marketplace.review.reply-submitted");
  });

  it("rate limits Review authoring per account before reading the body", async () => {
    process.env[RATE_LIMIT_MAX_ENV] = "2";
    const fixture = createFixture();
    const submitReview = vi.spyOn(fixture.runtime, "submitReview");

    await fixture.post("", { orderId: "ord_1", subjectAccountId: "acc_seller", rating: 5, feedback: "\u0000" });
    await fixture.post("/rev_missing/update", { rating: 5, feedback: "Fine" });
    const limited = await fixture.post("", { orderId: "ord_1", subjectAccountId: "acc_seller", rating: 5 });
    const body = (await limited.json()) as { error: { code: string; surface: string } };

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(body.error).toMatchObject({ code: "rate_limited", surface: "marketplace.review.authoring" });
    expect(submitReview).toHaveBeenCalledTimes(1);
    expect(fixture.allEvents).toHaveLength(0);

    fixture.actAs("acc_seller");
    expect((await fixture.post("/rev_missing/reply", { feedback: "Hello" })).status).not.toBe(429);
  });

  it("uses one closed recovery copy per code", () => {
    expect(authoredTextRecoveryMessage("text_unsafe_link")).toBe(
      t("marketplace.features.reviews.ui.authoredTextRecovery.unsafeLink"),
    );
    expect(authoredTextRecoveryMessage("rate_limited")).toBe(
      t("marketplace.features.reviews.ui.authoredTextRecovery.rateLimited"),
    );
    expect(authoredTextRecoveryMessage("validation_failed")).toBeNull();
  });
});
