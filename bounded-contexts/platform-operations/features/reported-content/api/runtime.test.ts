import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createReportedContentRuntime } from "./runtime";
import { createId } from "@chase-sets/primitives/typed-ids";
import { REPORTED_CONTENT_ACTIONS_BY_TARGET_TYPE } from "./contracts";

function createDeps() {
  const appendToStream = vi.fn().mockResolvedValue([]);
  const eventStore = { appendToStream } as unknown as EventStore;
  const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as PgQueryable;
  return { eventStore, db, appendToStream };
}

const context = { tenantId: "tnt_1", audit: { performedByUserId: "usr_ops", forAccountId: "acc_ops" } } as never;

describe("reported content runtime moderation actions (m108, #4269)", () => {
  it("action matrix appends the unchanged audit then a directive only for listing unlist", async () => {
    for (const targetType of ["listing", "review"] as const) {
      for (const action of REPORTED_CONTENT_ACTIONS_BY_TARGET_TYPE[targetType]) {
        const deps = createDeps();
        const params = {
          targetType,
          targetId: createId(targetType === "listing" ? "lst" : "rev"),
          action,
          note: "Operator reason",
          operatorUserId: createId("usr"),
        };
        const result = await createReportedContentRuntime(deps).recordModerationAction(params, context);
        expect(deps.appendToStream).toHaveBeenCalledTimes(1);
        const append = deps.appendToStream.mock.calls[0]![0];
        expect(append).toMatchObject({ expectedVersion: "any", context });
        expect(append.events[0]).toEqual({
          eventType: "platform-operations.reported-content.action-recorded",
          payload: { ...params, ...result },
        });
        expect(append.events.slice(1)).toEqual(
          targetType === "listing" && action === "unlist"
            ? [
                {
                  eventType: "platform-operations.reported-content.listing-removal-directed",
                  payload: {
                    actionId: result.actionId,
                    listingId: params.targetId,
                    operatorUserId: params.operatorUserId,
                    directedAt: result.recordedAt,
                  },
                },
              ]
            : [],
        );
      }
    }
  });

  it("rejects invalid listing directive identities before appending either event", async () => {
    for (const overrides of [{ targetId: "lst_invalid" }, { operatorUserId: "usr_invalid" }]) {
      const deps = createDeps();
      await expect(
        createReportedContentRuntime(deps).recordModerationAction(
          {
            targetType: "listing",
            targetId: createId("lst"),
            action: "unlist",
            note: null,
            operatorUserId: null,
            ...overrides,
          },
          context,
        ),
      ).rejects.toThrow();
      expect(deps.appendToStream).not.toHaveBeenCalled();
    }
  });

  it("preserves a nullable directive actor and propagates the failed atomic append", async () => {
    const deps = createDeps();
    const failure = new Error("append failed");
    deps.appendToStream.mockRejectedValue(failure);
    await expect(
      createReportedContentRuntime(deps).recordModerationAction(
        {
          targetType: "listing",
          targetId: createId("lst"),
          action: "unlist",
          note: null,
          operatorUserId: null,
        },
        context,
      ),
    ).rejects.toBe(failure);
    expect(deps.appendToStream).toHaveBeenCalledTimes(1);
    expect(deps.appendToStream.mock.calls[0]![0].events[1].payload.operatorUserId).toBeNull();
  });

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
