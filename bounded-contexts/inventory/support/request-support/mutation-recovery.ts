import type { InventoryMutationFamily } from "../runtime-support/mutation-intent";
import type { InventoryMutationReceipt } from "../runtime-support/mutation-attempt";

export type InventoryRecoveryState =
  | "editing"
  | "submitting"
  | "confirming"
  | "succeeded"
  | "failed-safe"
  | "ambiguous"
  | "reauth-required";
export type InventoryRecoveryAuthority = Readonly<{ accountId: string; actorUserId: string }>;
export type InventoryRecoveryRecord = Readonly<{
  version: 1;
  attemptId: string;
  accountId: string;
  actorUserId: string;
  family: InventoryMutationFamily;
  targetId: string;
  createdAt: string;
}>;
export type InventoryRecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type InventoryRecoveryReceipt = InventoryMutationReceipt;

const families: readonly InventoryMutationFamily[] = [
  "item-create",
  "item-adjust",
  "listing-stock-ensure",
  "hold-create",
  "hold-release",
  "location-create",
  "location-update",
  "location-archive",
  "restock-record",
  "import-create",
  "import-resolve-row",
];

const fields = ["version", "attemptId", "accountId", "actorUserId", "family", "targetId", "createdAt"];

function key(authority: InventoryRecoveryAuthority, family: InventoryMutationFamily) {
  return `inventory-mutation/v1:${encodeURIComponent(authority.accountId)}:${family}`;
}

function validRecord(value: unknown): value is InventoryRecoveryRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    Object.keys(input).length === fields.length &&
    Object.keys(input).every((field) => fields.includes(field)) &&
    input.version === 1 &&
    typeof input.attemptId === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.attemptId) &&
    typeof input.accountId === "string" &&
    input.accountId.length > 0 &&
    input.accountId.length < 256 &&
    typeof input.actorUserId === "string" &&
    input.actorUserId.length > 0 &&
    input.actorUserId.length < 256 &&
    typeof input.targetId === "string" &&
    input.targetId.length > 0 &&
    input.targetId.length < 256 &&
    typeof input.family === "string" &&
    families.includes(input.family as InventoryMutationFamily) &&
    typeof input.createdAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.createdAt) &&
    Number.isFinite(Date.parse(input.createdAt))
  );
}

export function createInventoryMutationRecovery(
  authority: InventoryRecoveryAuthority,
  family: InventoryMutationFamily,
  storage: InventoryRecoveryStorage,
) {
  let state: InventoryRecoveryState = "editing";
  let record: InventoryRecoveryRecord | null = null;
  let result: unknown;
  let confirmation: Promise<void> | null = null;

  function persist() {
    if (!record) return;
    const persistence: InventoryRecoveryStorage = storage;
    persistence.setItem(key(authority, family), JSON.stringify(record));
  }
  function remove() {
    const persistence: InventoryRecoveryStorage = storage;
    persistence.removeItem(key(authority, family));
    record = null;
  }
  function restore() {
    const persistence: InventoryRecoveryStorage = storage;
    const encoded = persistence.getItem(key(authority, family));
    if (encoded === null) return;
    if (encoded.length > 2048) {
      state = "ambiguous";
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded);
    } catch {
      state = "ambiguous";
      return;
    }
    if (!validRecord(decoded) || decoded.family !== family) {
      state = "ambiguous";
      return;
    }
    if (decoded.accountId !== authority.accountId || decoded.actorUserId !== authority.actorUserId) {
      state = "reauth-required";
      return;
    }
    record = decoded;
    state = "confirming";
  }
  restore();

  return {
    snapshot: () => ({
      state,
      record,
      result,
      writesDisabled: ["submitting", "confirming", "ambiguous", "reauth-required"].includes(state),
    }),
    begin: (targetId: string, attemptId = globalThis.crypto.randomUUID(), createdAt = new Date().toISOString()) => {
      if (record || !["editing", "failed-safe", "succeeded"].includes(state))
        throw new Error("Inventory recovery must be resolved before another write.");
      const next = { version: 1 as const, attemptId, ...authority, family, targetId, createdAt };
      if (!validRecord(next)) throw new Error("Inventory recovery metadata is invalid.");
      record = next;
      try {
        persist();
      } catch (error) {
        record = null;
        state = "failed-safe";
        throw error;
      }
      state = "submitting";
      result = undefined;
      return attemptId;
    },
    possibleSendLoss: () => {
      if (record && state === "submitting") state = "confirming";
    },
    refusedBeforeAcceptance: () => {
      if (state !== "submitting")
        throw new Error("Only a known pre-acceptance refusal can release a submitted attempt.");
      remove();
      state = "failed-safe";
    },
    confirm: (read: (attemptId: string) => Promise<InventoryRecoveryReceipt | null>) => {
      if (confirmation) return confirmation;
      if (!record || !["confirming", "ambiguous", "reauth-required"].includes(state)) return Promise.resolve();
      const frozen = record;
      state = "confirming";
      const task = (async () => {
        try {
          const receipt = await read(frozen.attemptId);
          if (record !== frozen) return;
          if (!receipt || receipt.version !== 1 || receipt.family !== family || receipt.targetId !== frozen.targetId) {
            state = "ambiguous";
            return;
          }
          result = receipt.result;
          remove();
          state = "succeeded";
        } catch (error) {
          if (record !== frozen) return;
          state =
            typeof error === "object" &&
            error !== null &&
            "status" in error &&
            (error.status === 401 || error.status === 403)
              ? "reauth-required"
              : "ambiguous";
        }
      })();
      confirmation = task;
      return task.finally(() => {
        if (confirmation === task) confirmation = null;
      });
    },
    accepted: (receipt: InventoryRecoveryReceipt) => {
      if (
        !record ||
        state !== "submitting" ||
        receipt.version !== 1 ||
        receipt.family !== family ||
        receipt.targetId !== record.targetId
      )
        throw new Error("Inventory result does not match the submitted attempt.");
      result = receipt.result;
      remove();
      state = "succeeded";
    },
    discard: () => {
      if (!["ambiguous", "reauth-required"].includes(state))
        throw new Error("An active Inventory attempt cannot be discarded.");
      remove();
      state = "editing";
      result = undefined;
    },
  };
}
