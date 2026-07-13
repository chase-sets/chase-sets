import { describe, expect, it } from "vitest";
import {
  decideCatalogAttentionDismissal,
  evolveCatalogAttentionDismissal,
  initialCatalogAttentionDismissalState,
  type CatalogAttentionDismissalCommand,
  type CatalogAttentionDismissalEvent,
  type CatalogAttentionDismissalState,
} from "./dismissal";

function applyDecision(
  state: CatalogAttentionDismissalState,
  command: CatalogAttentionDismissalCommand,
): { state: CatalogAttentionDismissalState; events: readonly CatalogAttentionDismissalEvent[] } {
  const events = decideCatalogAttentionDismissal(state, command) as readonly CatalogAttentionDismissalEvent[];
  return { state: events.reduce(evolveCatalogAttentionDismissal, state), events };
}

describe("catalog attention-item dismissal aggregate", () => {
  it("dismisses an active item and records the reason", () => {
    const { state, events } = applyDecision(initialCatalogAttentionDismissalState, {
      type: "DismissAttentionItem",
      itemKey: "merge-conflict:c1",
      kind: "merge-conflict",
      actor: "operator-1",
      reason: "waiting on provider",
    });
    expect(events).toHaveLength(1);
    expect(state.disposition).toBe("dismissed");
    expect(state.reason).toBe("waiting on provider");
    expect(state.deferredUntil).toBeNull();
  });

  it("defers an item with a re-surface time and restores back to active", () => {
    const deferred = applyDecision(initialCatalogAttentionDismissalState, {
      type: "DeferAttentionItem",
      itemKey: "import-job:j1",
      kind: "import-job",
      actor: "operator-1",
      reason: "retry tomorrow",
      deferredUntil: "2026-07-10T00:00:00.000Z",
    });
    expect(deferred.state.disposition).toBe("deferred");
    expect(deferred.state.deferredUntil).toBe("2026-07-10T00:00:00.000Z");

    const restored = applyDecision(deferred.state, {
      type: "RestoreAttentionItem",
      itemKey: "import-job:j1",
      actor: "operator-1",
    });
    expect(restored.state.disposition).toBe("active");
    expect(restored.state.deferredUntil).toBeNull();
  });

  it("is idempotent for a repeated identical dismissal and for restoring an active item", () => {
    const dismissed = applyDecision(initialCatalogAttentionDismissalState, {
      type: "DismissAttentionItem",
      itemKey: "alias-candidate:h1",
      kind: "alias-candidate",
      actor: "operator-1",
      reason: "duplicate",
    });
    const repeat = decideCatalogAttentionDismissal(dismissed.state, {
      type: "DismissAttentionItem",
      itemKey: "alias-candidate:h1",
      kind: "alias-candidate",
      actor: "operator-1",
      reason: "duplicate",
    });
    expect(repeat).toHaveLength(0);

    const restoreActive = decideCatalogAttentionDismissal(initialCatalogAttentionDismissalState, {
      type: "RestoreAttentionItem",
      itemKey: "alias-candidate:h1",
      actor: "operator-1",
    });
    expect(restoreActive).toHaveLength(0);
  });

  it("requires a reason to dismiss or defer and a valid time to defer", () => {
    expect(() =>
      decideCatalogAttentionDismissal(initialCatalogAttentionDismissalState, {
        type: "DismissAttentionItem",
        itemKey: "x",
        kind: "unmapped-scope",
        actor: "operator-1",
        reason: "  ",
      }),
    ).toThrow();
    expect(() =>
      decideCatalogAttentionDismissal(initialCatalogAttentionDismissalState, {
        type: "DeferAttentionItem",
        itemKey: "x",
        kind: "unmapped-scope",
        actor: "operator-1",
        reason: "later",
        deferredUntil: "not-a-date",
      }),
    ).toThrow();
  });
});
