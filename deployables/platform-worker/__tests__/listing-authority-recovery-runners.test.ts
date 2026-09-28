import { describe, expect, it, vi } from "vitest";
import type { PlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createListingAuthorityRecoveryRunners } from "../src/listing-authority-recovery-runners";

function cursorDb(): PgQueryable {
  const rows = new Map<string, { revision: string; event_after: string; sql_after: string }>();
  return {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      const owner = String(values![0]);
      const row = rows.get(owner);
      if (sql.startsWith("SELECT")) return { rows: (row ? [row] : []) as Row[] };
      const revision = String(values![1]);
      if ((sql.includes("INSERT INTO") && row) || (sql.includes("UPDATE") && row?.revision !== revision))
        return { rows: [] as Row[] };
      const next = {
        revision: String(Number(revision) + 1),
        event_after: String(values![2]),
        sql_after: String(values![3]),
      };
      rows.set(owner, next);
      return { rows: [next] as Row[] };
    },
  };
}

describe("mounted Listing authority recovery", () => {
  const control = () =>
    ({
      claimScheduledRunner: vi.fn(async () => true),
      recordScheduledRunnerCompleted: vi.fn(async () => {}),
    }) as unknown as PlatformControlPlane;

  it("advances independent owner event and SQL cursors, wraps, and restarts from discovery only", async () => {
    const auth = vi
      .fn()
      .mockResolvedValueOnce({ after: "100", tokenAfter: "token-20", outcomes: [] })
      .mockResolvedValue({ after: "0", tokenAfter: "", outcomes: [] });
    const identity = vi
      .fn()
      .mockResolvedValueOnce({ after: "200", credentialAfter: "credential-30", outcomes: [] })
      .mockResolvedValue({ after: "0", credentialAfter: "", outcomes: [] });
    const services = {
      auth: { db: cursorDb(), sessions: { listingAuthority: { recoverPage: auth } } },
      identity: { db: cursorDb(), listingAuthority: { recoverPage: identity } },
    };
    const runners = createListingAuthorityRecoveryRunners(services, control());
    for (const runner of createListingAuthorityRecoveryRunners(services, control())) await runner.runOnce();
    for (const runner of runners) await runner.runOnce();
    expect(auth).toHaveBeenNthCalledWith(2, { after: "100", tokenAfter: "token-20", limit: 100 });
    expect(identity).toHaveBeenNthCalledWith(2, { after: "200", credentialAfter: "credential-30", limit: 100 });
    for (const runner of runners) await runner.runOnce();
    for (const runner of createListingAuthorityRecoveryRunners(services, control())) await runner.runOnce();
    expect(auth).toHaveBeenLastCalledWith({ after: "0", tokenAfter: "", limit: 100 });
    expect(identity).toHaveBeenLastCalledWith({ after: "0", credentialAfter: "", limit: 100 });
  });

  it("does not advance a failed page or block another owner's scheduled recovery", async () => {
    const catalog = vi
      .fn()
      .mockRejectedValueOnce(new Error("synthetic owner unavailable"))
      .mockResolvedValue({ nextCursor: "41", outcomes: [] });
    const inventory = vi.fn().mockResolvedValue({ nextCursor: "73", outcomes: [] });
    const reconcile = vi.fn(async () => 100);
    const runners = createListingAuthorityRecoveryRunners(
      {
        catalog: {
          db: cursorDb(),
          listingAuthority: { recover: catalog },
          productMeasures: { reconcileProfileAuthority: reconcile },
        },
        inventory: { db: cursorDb(), listingAuthority: { recover: inventory } },
      },
      control(),
    );
    await expect(runners[0]!.runOnce()).rejects.toThrow("synthetic owner unavailable");
    await runners[1]!.runOnce();
    await runners[0]!.runOnce();
    expect(catalog).toHaveBeenLastCalledWith({ after: "0", limit: 100 });
    await runners[2]!.runOnce();
    expect(reconcile).toHaveBeenCalledExactlyOnceWith();
    await runners[1]!.runOnce();
    expect(inventory).toHaveBeenLastCalledWith({ after: "73", limit: 100 });
  });

  it("binds Channels owner-wide discovery without inventing a tenant or a principal", async () => {
    const recover = vi
      .fn()
      .mockResolvedValueOnce({ nextCursor: "16", processed: 16 })
      .mockResolvedValue({ nextCursor: null, processed: 3 });
    const [runner] = createListingAuthorityRecoveryRunners(
      { channels: { db: cursorDb(), connections: { recoverAuthorityPage: recover } } },
      control(),
    );
    await runner!.runOnce();
    await runner!.runOnce();
    await runner!.runOnce();
    expect(recover.mock.calls).toEqual([
      [{ afterGlobalPosition: "0" }],
      [{ afterGlobalPosition: "16" }],
      [{ afterGlobalPosition: "0" }],
    ]);
  });
});
