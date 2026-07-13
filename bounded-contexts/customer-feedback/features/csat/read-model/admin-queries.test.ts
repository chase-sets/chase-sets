import { describe, expect, it, vi } from "vitest";
import { listCsatAdminQueue } from "./queries";

function row(invitationId: string, eligibleAt: string) {
  return {
    invitation_id: invitationId,
    state: "submitted",
    survey_kind: "transactional-csat",
    survey_version: "csat.v1",
    question_version: "csat.q.v1",
    outcome_code: "checkout.completed",
    subject_kind: "buyer",
    eligible_at: eligibleAt,
    issued_at: eligibleAt,
    presented_at: eligibleAt,
    submitted_at: eligibleAt,
    dismissed_at: null,
    expired_at: null,
    rating: 5,
    follow_up_consent: false,
  };
}

describe("CSAT admin queue query", () => {
  it("uses bounded keyset pages and stable eligible-time/id ordering", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db = {
      query: vi.fn(async (sql: string, params: readonly unknown[]) => {
        calls.push({ sql, params });
        return { rows: [row("inv_1", "2024-03-12T00:00:00.000Z"), row("inv_2", "2024-03-11T00:00:00.000Z")] };
      }),
    };

    const first = await listCsatAdminQueue(db as never, { limit: 1 });

    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.invitationId).toBe("inv_1");
    expect(first.nextCursor).not.toBeNull();
    expect(calls[0]?.sql).toContain("ORDER BY i.eligible_at DESC, i.invitation_id DESC");
    expect(calls[0]?.params.at(-1)).toBe(2);

    await listCsatAdminQueue(db as never, { cursor: first.nextCursor, limit: 1 });

    expect(calls[1]?.sql).toContain("(i.eligible_at, i.invitation_id) <");
    expect(calls[1]?.params.at(-1)).toBe(2);
  });

  it("reverses the bounded previous page for display while querying ascending", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [row("inv_2", "2024-03-11T00:00:00.000Z"), row("inv_1", "2024-03-12T00:00:00.000Z")],
      })),
    };

    const page = await listCsatAdminQueue(db as never, {
      cursor: Buffer.from(
        JSON.stringify({ version: 1, eligibleAt: "2024-03-13T00:00:00.000Z", invitationId: "inv_3" }),
      ).toString("base64url"),
      direction: "previous",
      limit: 2,
    });

    expect(page.items[0]?.invitationId).toBe("inv_1");
  });
});
