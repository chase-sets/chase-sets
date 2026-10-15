import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createInventoryMutationRecovery,
  type InventoryRecoveryStorage,
} from "../support/request-support/mutation-recovery";

const authority = { accountId: "acc_synthetic", actorUserId: "usr_synthetic" };
function storage() {
  const entries = new Map<string, string>();
  const result: InventoryRecoveryStorage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
  return { entries, result };
}
describe("issue-7169-c1-boundary-recovery: AC9/10/11/13 restore", () => {
  it.each(["invalid-json", "oversized", "unknown-field"])(
    "keeps %s recovery metadata ambiguous until explicit discard",
    (kind) => {
      const saved = storage();
      createInventoryMutationRecovery(authority, "item-create", saved.result).begin("draft", randomUUID());
      const slot = [...saved.entries.keys()][0];
      const value = saved.entries.get(slot)!;
      saved.entries.set(
        slot,
        kind === "invalid-json"
          ? "{"
          : kind === "oversized"
            ? "x".repeat(2049)
            : JSON.stringify({ ...JSON.parse(value), unknown: true }),
      );
      const restored = createInventoryMutationRecovery(authority, "item-create", saved.result);
      expect(restored.snapshot()).toMatchObject({ state: "ambiguous", record: null, writesDisabled: true });
      expect(() => restored.begin("draft", randomUUID())).toThrow("resolved");
      expect(saved.entries.size).toBe(1);
      restored.discard();
      expect(saved.entries.size).toBe(0);
    },
  );
  it("restores one bounded account-operation record and only reads after a possible send", async () => {
    const saved = storage();
    const original = createInventoryMutationRecovery(authority, "item-create", saved.result);
    const attemptId = original.begin("draft", randomUUID());
    original.possibleSendLoss();
    const restored = createInventoryMutationRecovery(authority, "item-create", saved.result);
    expect(restored.snapshot()).toMatchObject({ state: "confirming", writesDisabled: true });
    expect(() => restored.begin("draft", randomUUID())).toThrow("resolved");
    const read = vi.fn(async () => null);
    await restored.confirm(read);
    expect(read).toHaveBeenCalledWith(attemptId);
    expect(restored.snapshot()).toMatchObject({ state: "ambiguous", writesDisabled: true });
    expect(saved.entries.size).toBe(1);
    expect([...saved.entries.values()][0].length).toBeLessThan(2048);
    const lookup = vi.fn(async () => ({
      version: 1 as const,
      family: "item-create" as const,
      targetId: "draft",
      result: { itemId: "inv_synthetic", version: 1 },
      completedAt: "2026-10-13T00:00:00Z",
    }));
    await restored.confirm(lookup);
    expect(restored.snapshot()).toMatchObject({
      state: "succeeded",
      result: { itemId: "inv_synthetic", version: 1 },
      writesDisabled: false,
    });
    expect(saved.entries.size).toBe(0);
    await restored.confirm(lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it("never restores another actor/account and never stores raw input or result", () => {
    const saved = storage();
    const client = createInventoryMutationRecovery(authority, "hold-create", saved.result);
    client.begin("inv_synthetic", randomUUID());
    expect(
      createInventoryMutationRecovery({ ...authority, accountId: "acc_other" }, "hold-create", saved.result).snapshot(),
    ).toMatchObject({ state: "editing", record: null });
    expect(
      createInventoryMutationRecovery(
        { ...authority, actorUserId: "usr_other" },
        "hold-create",
        saved.result,
      ).snapshot(),
    ).toMatchObject({ state: "reauth-required", record: null, writesDisabled: true });
    expect(Object.keys(JSON.parse([...saved.entries.values()][0])).sort()).toEqual([
      "accountId",
      "actorUserId",
      "attemptId",
      "createdAt",
      "family",
      "targetId",
      "version",
    ]);
  });
  it("requires explicit safe discard, keeps reauth private and does not treat a missing receipt as permission to resubmit", async () => {
    const saved = storage();
    const client = createInventoryMutationRecovery(authority, "location-create", saved.result);
    client.begin("draft", randomUUID());
    client.possibleSendLoss();
    await client.confirm(async () => {
      throw { status: 401 };
    });
    expect(client.snapshot()).toMatchObject({ state: "reauth-required", writesDisabled: true });
    expect(() => client.begin("draft", randomUUID())).toThrow();
    client.discard();
    expect(client.snapshot()).toMatchObject({ state: "editing", record: null });
    expect(saved.entries.size).toBe(0);
  });
  it("sends nothing when persistence fails and only releases a known pre-acceptance refusal", () => {
    const saved = storage();
    const client = createInventoryMutationRecovery(authority, "item-adjust", {
      ...saved.result,
      setItem: () => {
        throw new Error("Synthetic storage refusal");
      },
    });
    expect(() => client.begin("inv_synthetic", randomUUID())).toThrow("storage refusal");
    expect(client.snapshot()).toMatchObject({ state: "failed-safe", record: null });
    const safe = createInventoryMutationRecovery(authority, "item-adjust", saved.result);
    safe.begin("inv_synthetic", randomUUID());
    safe.refusedBeforeAcceptance();
    expect(safe.snapshot()).toMatchObject({ state: "failed-safe", record: null });
    safe.begin("inv_synthetic", randomUUID());
    safe.possibleSendLoss();
    expect(() => safe.refusedBeforeAcceptance()).toThrow("known pre-acceptance");
  });
});
