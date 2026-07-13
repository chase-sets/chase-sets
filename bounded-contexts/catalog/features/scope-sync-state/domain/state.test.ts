import { describe, expect, it } from "vitest";
import {
  catalogScopeSyncUnitIsFastForwardable,
  computeCatalogSyncScopeKey,
  deriveCatalogScopeSyncUnitState,
  type CatalogScopeSyncUnitObservedStatus,
} from "./state";

describe("deriveCatalogScopeSyncUnitState", () => {
  it("maps a normal success path to settled", () => {
    const path: readonly CatalogScopeSyncUnitObservedStatus[] = ["queued", "running", "completed"];
    const states = path.map(deriveCatalogScopeSyncUnitState);

    expect(states).toEqual(["pending", "running", "settled"]);
  });

  it("maps a failed provider to failed, independent of siblings", () => {
    expect(deriveCatalogScopeSyncUnitState("failed")).toBe("failed");
    expect(deriveCatalogScopeSyncUnitState("cancelled")).toBe("failed");
    expect(deriveCatalogScopeSyncUnitState("enqueue-failed")).toBe("failed");
  });

  it("recovers a failed provider through retry without needing to know about other units", () => {
    const path: readonly CatalogScopeSyncUnitObservedStatus[] = ["failed", "queued", "retried", "completed"];
    const states = path.map(deriveCatalogScopeSyncUnitState);

    expect(states).toEqual(["failed", "pending", "running", "settled"]);
  });

  it("maps a fast-forwarded reuse of a prior settled job to settled", () => {
    expect(deriveCatalogScopeSyncUnitState("reused-settled-job")).toBe("settled");
  });

  it("maps a stale claim to stale, distinct from failed", () => {
    expect(deriveCatalogScopeSyncUnitState("stale")).toBe("stale");
  });

  it("maps partial outcomes to running (still needs attention before it can settle)", () => {
    expect(deriveCatalogScopeSyncUnitState("partial")).toBe("running");
  });
});

describe("catalogScopeSyncUnitIsFastForwardable", () => {
  const childScope = { provider: "tcgdex", setId: "sv4-5" };

  it("is fast-forwardable only when settled and the child execution scope is unchanged", () => {
    expect(
      catalogScopeSyncUnitIsFastForwardable({
        state: "settled",
        storedChildExecutionScope: childScope,
        currentChildExecutionScope: { ...childScope },
      }),
    ).toBe(true);
  });

  it("is not fast-forwardable when not settled", () => {
    expect(
      catalogScopeSyncUnitIsFastForwardable({
        state: "pending",
        storedChildExecutionScope: childScope,
        currentChildExecutionScope: childScope,
      }),
    ).toBe(false);
  });

  it("is not fast-forwardable when the child execution scope has drifted (e.g. a mapping changed)", () => {
    expect(
      catalogScopeSyncUnitIsFastForwardable({
        state: "settled",
        storedChildExecutionScope: childScope,
        currentChildExecutionScope: { ...childScope, setId: "sv4-6" },
      }),
    ).toBe(false);
  });

  it("is not fast-forwardable when either scope is unknown", () => {
    expect(
      catalogScopeSyncUnitIsFastForwardable({
        state: "settled",
        storedChildExecutionScope: null,
        currentChildExecutionScope: childScope,
      }),
    ).toBe(false);
  });
});

describe("computeCatalogSyncScopeKey", () => {
  it("is stable for the same descriptor", () => {
    const descriptor = {
      productDomain: "trading-card",
      productForm: "single-card",
      languageCode: "en",
      referenceKind: "expansion",
      referenceId: "sv4-5",
      referenceName: "Paldean Fates",
    };

    expect(computeCatalogSyncScopeKey(descriptor)).toBe(computeCatalogSyncScopeKey({ ...descriptor }));
  });

  it("is case/whitespace-insensitive", () => {
    const descriptor = {
      productDomain: "trading-card",
      productForm: "single-card",
      languageCode: "en",
      referenceKind: "expansion",
      referenceId: "sv4-5",
      referenceName: "Paldean Fates",
    };

    expect(computeCatalogSyncScopeKey(descriptor)).toBe(
      computeCatalogSyncScopeKey({ ...descriptor, referenceId: "  SV4-5  " }),
    );
  });

  it("falls back to the reference name when no reference id is present", () => {
    const withId = computeCatalogSyncScopeKey({
      productDomain: "trading-card",
      productForm: "single-card",
      languageCode: "en",
      referenceKind: "set",
      referenceId: null,
      referenceName: "Paldean Fates",
    });
    const withNameOnly = computeCatalogSyncScopeKey({
      productDomain: "trading-card",
      productForm: "single-card",
      languageCode: "en",
      referenceKind: "set",
      referenceId: "Paldean Fates",
      referenceName: null,
    });

    expect(withId).toBe(withNameOnly);
  });

  it("differs when the reference changes", () => {
    const first = computeCatalogSyncScopeKey({
      productDomain: "trading-card",
      productForm: "single-card",
      languageCode: "en",
      referenceKind: "expansion",
      referenceId: "sv4-5",
      referenceName: "Paldean Fates",
    });
    const second = computeCatalogSyncScopeKey({
      productDomain: "trading-card",
      productForm: "single-card",
      languageCode: "en",
      referenceKind: "expansion",
      referenceId: "sv3-5",
      referenceName: "Obsidian Flames",
    });

    expect(first).not.toBe(second);
  });
});
