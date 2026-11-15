import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { PlatformOperationsApiEnv } from "../../../api";
import type { PlatformOperationsServices } from "../../../support/runtime-support/services";
import { createOperationsAttentionRoutes } from "../api/route";
import { mapReportedContentToItems, type ReportedContentAttentionInput } from "./sources";
import { compareOperationsAttentionItems } from "./ordering";

const context = { now: "2026-11-16T18:00:00.000Z" };
const item: ReportedContentAttentionInput = {
  target_type: "listing",
  target_id: "lst_1",
  response_open: true,
  severity: "high",
  acknowledge_due_at: "2026-11-16T19:00:00.000Z",
  disposition_due_at: "2026-11-17T15:00:00.000Z",
  accountable_role: "Founder",
  policy_code: null,
  updated_at: "2026-11-16T15:00:00.000Z",
};

function appFor(listReportedContentQueue: unknown, permission = true) {
  const app = new Hono<PlatformOperationsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", { userId: "usr_ops", permissions: permission ? ["reported-content.view"] : [] } as never);
    await next();
  });
  app.route(
    "/",
    createOperationsAttentionRoutes({
      reportedContent: { listReportedContentQueue },
    } as unknown as PlatformOperationsServices),
  );
  return app;
}

describe("reported-content-attention-source", () => {
  it("includes open high, critical and overdue standard, excludes disposed and strips private markers", () => {
    const rows = [
      { ...item, details: "PRIVATE_TEXT", reporterAccountId: "PRIVATE_REPORTER" },
      { ...item, target_id: "critical", severity: "critical" as const },
      { ...item, target_id: "overdue", severity: "standard" as const, acknowledge_due_at: "2026-11-16T17:00:00.000Z" },
      { ...item, target_id: "standard", severity: "standard" as const },
      { ...item, target_id: "disposed", response_open: false },
    ];
    const items = mapReportedContentToItems(rows, context).sort(compareOperationsAttentionItems);
    expect(items.map((entry) => entry.id)).toEqual([
      "reported-content-response:listing:overdue",
      "reported-content-response:listing:critical",
      "reported-content-response:listing:lst_1",
    ]);
    expect(items[2]).toMatchObject({
      dueAt: item.acknowledge_due_at,
      deepLink: { href: "/reported-content/listing/lst_1" },
      summary: { params: { severity: "high", role: "Founder" } },
    });
    expect(JSON.stringify(items)).not.toMatch(/PRIVATE|reporter|details/);
  });
  it("loads at cap 200 and exposes the decisive 201st row as explicitly incomplete", async () => {
    const fixture = [
      ...Array.from({ length: 200 }, (_, i) => ({ ...item, target_id: `lst_${i}` })),
      { ...item, target_id: "decisive-past-cap", severity: "critical" as const },
    ];
    const load = vi.fn(async ({ limit }: { limit?: number }) => ({
      items: fixture.slice(0, limit),
      total: fixture.length,
    }));
    const response = await appFor(load).request("/");
    const queue = await response.json();
    expect(load).toHaveBeenCalledWith({ attentionOnly: true, limit: 200, offset: 0 });
    expect(queue.items).toHaveLength(201);
    expect(queue.items).toContainEqual(
      expect.objectContaining({
        id: "reported-content-response:incomplete",
        summary: { code: "reportedContentIncomplete", params: {} },
      }),
    );
    expect(queue.sources[0].total).toBe("unknown");
    expect(queue.items.some((entry: { id: string }) => entry.id.endsWith("decisive-past-cap"))).toBe(false);
  });
  it("does not read without the permission, handles unavailable sources without leaking the exception, and clears disposition", async () => {
    const load = vi.fn(async () => {
      throw new Error("PRIVATE_REPORTER_TEXT");
    });
    expect((await (await appFor(load, false).request("/")).json()).items).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    const queue = await (await appFor(load).request("/")).json();
    expect(queue.items[0].id).toBe("reported-content-response:incomplete");
    expect(JSON.stringify(queue)).not.toContain("PRIVATE");
    const disposed = await (
      await appFor(async () => ({ items: [{ ...item, response_open: false }], total: 0 })).request("/")
    ).json();
    expect(disposed.items).toEqual([]);
  });
});
