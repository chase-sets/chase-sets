import { afterEach, expect, it, vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { connectionWriterProbe, createConnectionEpochsForWitness } from "./listing-activation-test-support";

afterEach(() => {
  connectionWriterProbe.omit = () => false;
});

it("applies the omission probe to the factory exported to the composition witness", async () => {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const pool: PgTransactionalPool = {
    query,
    connect: async () => ({ query, release: vi.fn() }),
  };
  connectionWriterProbe.omit = () => true;
  const work = vi.fn(async () => "synthetic writer result");
  const epochs = await createConnectionEpochsForWitness(pool);
  await expect(epochs.transaction(["connection/synthetic"], work)).resolves.toBe("synthetic writer result");
  expect(work).toHaveBeenCalledOnce();

  connectionWriterProbe.omit = () => false;
  const protectedWork = vi.fn(async () => "must not execute without source authority");
  await expect(epochs.transaction(["connection/synthetic"], protectedWork)).rejects.toThrow(
    "Channels source incarnation unavailable",
  );
  expect(protectedWork).not.toHaveBeenCalled();
});
