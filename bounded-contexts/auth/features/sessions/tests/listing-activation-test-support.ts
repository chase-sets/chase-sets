import { vi } from "vitest";
import { withConfigurationEpochTransaction } from "@chase-sets/event-core-postgres";

export const upsertSessionToken: typeof import("../../../support/auth-support/store").upsertSessionToken = async (
  ...args
) => (await import("../../../support/auth-support/store")).upsertSessionToken(...args);
export const seedSessionToken: typeof import("../../../support/seed-support/store").upsertSessionToken = async (
  ...args
) => (await import("../../../support/seed-support/store")).upsertSessionToken(...args);
export const revokeSession: typeof import("../../../support/runtime-support/services").revokeSession = async (
  ...args
) => (await import("../../../support/runtime-support/services")).revokeSession(...args);

const control = vi.hoisted(() => ({ omit: (): boolean => false }));
export const authWriterProbe = control;

vi.mock("../api/owner-epochs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/owner-epochs")>();
  const create: typeof actual.createAuthSessionEpochs = (pool, ...args) => {
    const epochs = actual.createAuthSessionEpochs(pool, ...args);
    return {
      ...epochs,
      transaction: (keys, work) =>
        control.omit() ? withConfigurationEpochTransaction(pool, work) : epochs.transaction(keys, work),
    };
  };
  return { ...actual, createAuthSessionEpochs: create };
});
