import { describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "@chase-sets/event-core/domain";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createBulkLifecycleOperations } from "./bulk-lifecycle";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
};

type TestCommand = Readonly<{ type: "Publish" }>;
type TestState = Readonly<{ status: string }>;
type TestEvent = DomainEvent<"Published", Record<string, never>>;

describe("bulk lifecycle operations", () => {
  it("previews mixed eligibility from explicit ids in selection order", async () => {
    const bulkLifecycle = createBulkLifecycleOperations<unknown, TestCommand, TestState, TestEvent>({
      actions: [
        {
          action: "publish",
          readyStatus: "draft",
          command: { type: "Publish" },
          streamId: (id) => `test-${id}`,
          blockedReason: (status) => `Expected draft, found ${status}.`,
        },
      ],
      commandHandler: vi.fn(),
      resolveIds: async (selection) => (selection.mode === "ids" ? selection.ids : []),
      loadRows: async () => [
        { id: "one", label: "One", status: "draft" },
        { id: "two", label: "Two", status: "active" },
      ],
    });

    const preview = await bulkLifecycle.preview({ mode: "ids", ids: ["one", "two", "missing"] }, "publish");

    expect(preview).toMatchObject({
      mode: "ids",
      action: "publish",
      ids: ["one", "two", "missing"],
      total: 3,
      ready_count: 1,
      blocked_count: 2,
    });
    expect(preview.candidates.map((candidate) => candidate.outcome)).toEqual(["ready", "blocked", "blocked"]);
  });

  it("executes only ready candidates and drains projectors", async () => {
    const commandHandler = vi.fn(async () => ({
      state: { status: "active" },
      version: 2,
      newEvents: [],
      storedEvents: [],
    }));
    const projector = {
      runOnce: vi.fn().mockResolvedValueOnce({ processed: 1 }).mockResolvedValueOnce({ processed: 0 }),
    };
    const bulkLifecycle = createBulkLifecycleOperations<{ status?: string }, TestCommand, TestState, TestEvent>({
      actions: [
        {
          action: "publish",
          readyStatus: "draft",
          command: { type: "Publish" },
          streamId: (id) => `test-${id}`,
          blockedReason: (status) => `Expected draft, found ${status}.`,
        },
      ],
      commandHandler,
      resolveIds: async (selection) =>
        selection.mode === "filter" && selection.query.status === "draft" ? ["one", "two"] : [],
      loadRows: async () => [
        { id: "one", label: "One", status: "draft" },
        { id: "two", label: "Two", status: "active" },
      ],
      projectors: [projector as never],
    });

    const result = await bulkLifecycle.execute({ mode: "filter", query: { status: "draft" } }, "publish", context);

    expect(commandHandler).toHaveBeenCalledTimes(1);
    expect(commandHandler).toHaveBeenCalledWith({
      streamId: "test-one",
      command: { type: "Publish" },
      context,
    });
    expect(projector.runOnce).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      action: "publish",
      ids: ["one", "two"],
      total: 2,
      succeeded_count: 1,
      skipped_count: 1,
      failed_count: 0,
    });
    expect(result.candidates.map((candidate) => candidate.outcome)).toEqual(["succeeded", "skipped"]);
  });
});
