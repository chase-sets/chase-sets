import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createReportedContentRuntime } from "./runtime";

function createDeps() {
  const appendToStream = vi.fn().mockResolvedValue([]);
  const eventStore = { appendToStream } as unknown as EventStore;
  const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as PgQueryable;
  return { eventStore, db, appendToStream };
}

const context = { tenantId: "tnt_1", audit: { performedByUserId: "usr_ops", forAccountId: "acc_ops" } } as never;

describe("reported content runtime moderation actions (m108, #4269)", () => {
  it("records a review-scoped action with a note", async () => {
    const { eventStore, db, appendToStream } = createDeps();
    const services = createReportedContentRuntime({ eventStore, db });

    await services.recordModerationAction(
      {
        targetType: "review",
        targetId: "rev_1",
        action: "withdraw-review",
        note: "Abusive language.",
        operatorUserId: "usr_ops",
      },
      context,
    );

    expect(appendToStream).toHaveBeenCalledTimes(1);
    const call = appendToStream.mock.calls[0]![0];
    expect(call.streamId).toBe("platform-operations.reported-content-review-rev_1");
    expect(call.events[0].payload).toMatchObject({
      targetType: "review",
      targetId: "rev_1",
      action: "withdraw-review",
      note: "Abusive language.",
    });
  });

  it("rejects a review-scoped action without a note", async () => {
    const { eventStore, db, appendToStream } = createDeps();
    const services = createReportedContentRuntime({ eventStore, db });

    await expect(
      services.recordModerationAction(
        { targetType: "review", targetId: "rev_1", action: "withdraw-review", note: null, operatorUserId: "usr_ops" },
        context,
      ),
    ).rejects.toThrow("requires a note");
    expect(appendToStream).not.toHaveBeenCalled();
  });

  it("rejects a listing-only action against a review target", async () => {
    const { eventStore, db, appendToStream } = createDeps();
    const services = createReportedContentRuntime({ eventStore, db });

    await expect(
      services.recordModerationAction(
        {
          targetType: "review",
          targetId: "rev_1",
          action: "unlist" as never,
          note: "Not applicable.",
          operatorUserId: "usr_ops",
        },
        context,
      ),
    ).rejects.toThrow("not valid for target type");
    expect(appendToStream).not.toHaveBeenCalled();
  });

  it("rejects a review-only action against a listing target", async () => {
    const { eventStore, db, appendToStream } = createDeps();
    const services = createReportedContentRuntime({ eventStore, db });

    await expect(
      services.recordModerationAction(
        {
          targetType: "listing",
          targetId: "lst_1",
          action: "withdraw-review" as never,
          note: "Not applicable.",
          operatorUserId: "usr_ops",
        },
        context,
      ),
    ).rejects.toThrow("not valid for target type");
    expect(appendToStream).not.toHaveBeenCalled();
  });

  it("still allows generic listing actions without a note", async () => {
    const { eventStore, db, appendToStream } = createDeps();
    const services = createReportedContentRuntime({ eventStore, db });

    await services.recordModerationAction(
      { targetType: "listing", targetId: "lst_1", action: "dismiss", note: null, operatorUserId: "usr_ops" },
      context,
    );

    expect(appendToStream).toHaveBeenCalledTimes(1);
  });
});
