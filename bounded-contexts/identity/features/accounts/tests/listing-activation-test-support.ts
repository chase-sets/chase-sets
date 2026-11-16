import { vi } from "vitest";

const control = vi.hoisted(() => ({ omit: (): boolean => false }));
export const identityWriterProbe = control;

vi.mock("../api/owner-epochs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/owner-epochs")>();
  const create: typeof actual.createIdentityOwnerEpochs = (...args) => {
    const epochs = actual.createIdentityOwnerEpochs(...args);
    return {
      ...epochs,
      enroll: (...inputs) => (control.omit() ? Promise.resolve() : epochs.enroll(...inputs)),
    };
  };
  return { ...actual, createIdentityOwnerEpochs: create };
});
