import { describe, expect, it, vi } from "vitest";

import {
  listProjectionReplayTargets,
  rebuildProjectionSelection,
  validateProjectionReplaySelection,
} from "./replay-projection-selection.ts";

const runtime = {
  projectionGroups: [
    { targetContextName: "checkout", projectionName: "checkout-ready" },
    { targetContextName: "catalog", projectionName: "source-observation-review" },
    { targetContextName: "checkout", projectionName: "sell-list" },
  ],
};

describe("projection replay target validation", () => {
  it("lists registered contexts and projections in stable order", () => {
    expect(listProjectionReplayTargets(runtime)).toEqual([
      {
        contextName: "catalog",
        projectionNames: ["source-observation-review"],
      },
      {
        contextName: "checkout",
        projectionNames: ["checkout-ready", "sell-list"],
      },
    ]);
  });

  it("rejects an unknown context with valid contexts before rebuild side effects", async () => {
    const rebuildOne = vi.fn();
    const rebuildAll = vi.fn();

    await expect(
      rebuildProjectionSelection(runtime, "checkot", "sell-list", {
        rebuildAllContextProjectionGroups: rebuildAll,
        rebuildContextProjectionGroup: rebuildOne,
      }),
    ).rejects.toThrow('Unknown projection context "checkot". Use one of: catalog, checkout. Did you mean "checkout"?');

    expect(rebuildOne).not.toHaveBeenCalled();
    expect(rebuildAll).not.toHaveBeenCalled();
  });

  it("rejects an unknown projection with valid projections for the selected context before rebuild side effects", async () => {
    const rebuildOne = vi.fn();
    const rebuildAll = vi.fn();

    await expect(
      rebuildProjectionSelection(runtime, "checkout", "sll-list", {
        rebuildAllContextProjectionGroups: rebuildAll,
        rebuildContextProjectionGroup: rebuildOne,
      }),
    ).rejects.toThrow(
      'Unknown projection "sll-list" for context "checkout". Use one of: checkout-ready, sell-list. Did you mean "sell-list"?',
    );

    expect(rebuildOne).not.toHaveBeenCalled();
    expect(rebuildAll).not.toHaveBeenCalled();
  });

  it("keeps --all and valid-name rebuild paths unchanged", async () => {
    const rebuildOne = vi.fn();
    const rebuildAll = vi.fn();

    await rebuildProjectionSelection(runtime, "checkout", "--all", {
      rebuildAllContextProjectionGroups: rebuildAll,
      rebuildContextProjectionGroup: rebuildOne,
    });
    await rebuildProjectionSelection(runtime, "checkout", "sell-list", {
      rebuildAllContextProjectionGroups: rebuildAll,
      rebuildContextProjectionGroup: rebuildOne,
    });

    expect(rebuildAll).toHaveBeenCalledWith(runtime, "checkout");
    expect(rebuildOne).toHaveBeenCalledWith(runtime, "checkout", "sell-list");
  });

  it("accepts valid selections without throwing", () => {
    expect(() => validateProjectionReplaySelection(runtime, "catalog", "source-observation-review")).not.toThrow();
  });
});
