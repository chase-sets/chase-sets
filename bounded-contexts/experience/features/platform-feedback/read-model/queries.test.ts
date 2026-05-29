import { describe, expect, it, vi } from "vitest";
import {
  getPlatformFeedbackMetrics,
  hasActivePromptSnooze,
  hasRecentPlatformFeedbackSubmission,
  listPlatformFeedback,
} from "./queries";

describe("platform feedback read-model queries", () => {
  it("applies queue filters and paging", async () => {
    const calls: unknown[][] = [];
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        calls.push([sql, params ?? []]);
        if (sql.includes("COUNT(*) AS count")) {
          return { rows: [{ count: "1" }] };
        }

        return {
          rows: [
            {
              feedback_id: "pfb_test",
              user_id: "usr_test",
              account_id: "acc_test",
              rating: 4,
              topic: "ease-of-use",
              comment: null,
              follow_up_consent: false,
              workflow: "listing-publish",
              source_route_path: "/account/listings",
              related_entities: [],
              related_entity_key: null,
              status: "new",
              submitted_at: "2026-05-07T12:00:00.000Z",
              updated_at: "2026-05-07T12:00:00.000Z",
              reviewed_by_user_id: null,
              reviewed_at: null,
              archived_by_user_id: null,
              archived_at: null,
            },
          ],
        };
      }),
    };

    const result = await listPlatformFeedback(db as never, {
      status: "new",
      topic: "ease-of-use",
      workflow: "listing-publish",
      limit: 500,
      offset: -10,
    });

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(String(calls[0]?.[0])).toContain("WHERE status = $1 AND topic = $2 AND workflow = $3");
    expect(calls[1]?.[1]).toEqual(["new", "ease-of-use", "listing-publish", 250, 0]);
  });

  it("uses entity-wide duplicate checks and workflow 30 day duplicate checks", async () => {
    const calls: unknown[][] = [];
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        calls.push([sql, params ?? []]);
        return { rows: [{ feedback_id: "pfb_existing" }] };
      }),
    };

    await expect(
      hasRecentPlatformFeedbackSubmission(db as never, {
        accountId: "acc_test",
        workflow: "checkout-payment",
        relatedEntityKey: "payment:pay_test",
        submittedAfter: "2026-04-07T12:00:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(
      hasRecentPlatformFeedbackSubmission(db as never, {
        accountId: "acc_test",
        workflow: "listing-publish",
        relatedEntityKey: null,
        submittedAfter: "2026-04-07T12:00:00.000Z",
      }),
    ).resolves.toBe(true);

    expect(String(calls[0]?.[0])).toContain("related_entity_key = $3");
    expect(calls[0]?.[1]).toEqual(["acc_test", "checkout-payment", "payment:pay_test"]);
    expect(String(calls[1]?.[0])).toContain("submitted_at >= $3");
    expect(calls[1]?.[1]).toEqual(["acc_test", "listing-publish", "2026-04-07T12:00:00.000Z"]);
  });

  it("checks active prompt snoozes and maps metrics groups", async () => {
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        if (sql.includes("FROM experience_platform_feedback_prompt_pages")) {
          expect(params).toEqual([
            "acc_test",
            "inventory-adjust",
            "inventoryItem:inv_test",
            "2026-05-07T12:00:00.000Z",
          ]);
          return { rows: [{ prompt_id: "pfp_test" }] };
        }

        if (sql.includes("COUNT(*) AS total_count")) {
          return {
            rows: [
              {
                total_count: "3",
                new_count: "1",
                reviewed_count: "1",
                archived_count: "1",
                average_rating: "4.33",
              },
            ],
          };
        }

        if (sql.includes("topic AS key")) {
          return {
            rows: [{ key: "ease-of-use", count: "2", average_rating: "4.50" }],
          };
        }

        if (sql.includes("workflow AS key")) {
          return {
            rows: [{ key: "checkout-payment", count: "1", average_rating: "5.00" }],
          };
        }

        return { rows: [] };
      }),
    };

    await expect(
      hasActivePromptSnooze(db as never, {
        accountId: "acc_test",
        workflow: "inventory-adjust",
        relatedEntityKey: "inventoryItem:inv_test",
        now: "2026-05-07T12:00:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(getPlatformFeedbackMetrics(db as never)).resolves.toEqual({
      total_count: 3,
      new_count: 1,
      reviewed_count: 1,
      archived_count: 1,
      average_rating: "4.33",
      by_topic: [{ topic: "ease-of-use", count: 2, averageRating: "4.50" }],
      by_workflow: [{ workflow: "checkout-payment", count: 1, averageRating: "5.00" }],
    });
  });
});
